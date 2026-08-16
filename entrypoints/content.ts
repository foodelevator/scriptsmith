const START_SELECTION_MESSAGE = 'scriptsmith:start-element-selection';
const CANCEL_SELECTION_MESSAGE = 'scriptsmith:cancel-element-selection';
const MAX_SELECTED_HTML = 2_000;

interface StartSelectionMessage {
  type: typeof START_SELECTION_MESSAGE;
}

interface CancelSelectionMessage {
  type: typeof CANCEL_SELECTION_MESSAGE;
}

type PageMessage = StartSelectionMessage | CancelSelectionMessage;

function normalizedText(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

function escapedIdentifier(value: string): string {
  return CSS.escape(value);
}

function selectorFor(element: Element): string {
  if (element.id && document.querySelectorAll(`#${escapedIdentifier(element.id)}`).length === 1) {
    return `#${escapedIdentifier(element.id)}`;
  }

  const parts: string[] = [];
  let current: Element | null = element;
  while (current && current !== document.documentElement) {
    if (current.id && document.querySelectorAll(`#${escapedIdentifier(current.id)}`).length === 1) {
      parts.unshift(`#${escapedIdentifier(current.id)}`);
      return parts.join(' > ');
    }

    const tag = current.tagName.toLowerCase();
    const siblings = current.parentElement
      ? Array.from(current.parentElement.children).filter(
          (candidate) => candidate.tagName === current?.tagName,
        )
      : [];
    const position = siblings.indexOf(current) + 1;
    parts.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${position})` : tag);
    current = current.parentElement;
  }

  parts.unshift('html');
  return parts.join(' > ');
}

interface ActivePicker {
  cancel(): void;
}

let activePicker: ActivePicker | null = null;

function elementLabel(element: Element): string {
  let label = element.tagName.toLowerCase();
  if (element.id) label += `#${element.id}`;
  for (const className of Array.from(element.classList).slice(0, 2)) {
    label += `.${className}`;
  }

  const accessibleText = normalizedText(
    element.getAttribute('aria-label') ||
      element.getAttribute('title') ||
      element.getAttribute('alt') ||
      element.getAttribute('placeholder') ||
      element.textContent,
  );
  if (accessibleText) {
    label += ` “${accessibleText.slice(0, 80)}${accessibleText.length > 80 ? '…' : ''}”`;
  }
  return label;
}

function pickerOverlay(): {
  host: HTMLElement;
  box: HTMLElement;
  tooltip: HTMLElement;
} {
  const host = document.createElement('div');
  host.setAttribute('data-scriptsmith-element-picker', '');
  for (const [property, value] of Object.entries({
    position: 'fixed',
    inset: '0',
    'z-index': '2147483647',
    'pointer-events': 'none',
  })) {
    host.style.setProperty(property, value, 'important');
  }

  const shadow = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = `
    .box {
      position: fixed;
      display: none;
      box-sizing: border-box;
      border: 1.5px solid #3b82f6;
      border-radius: 4px;
      background: rgb(59 130 246 / 14%);
      box-shadow:
        0 0 0 1px rgb(255 255 255 / 70%),
        0 0 12px rgb(59 130 246 / 35%);
    }
    .tooltip {
      position: fixed;
      display: none;
      max-width: min(360px, calc(100vw - 16px));
      overflow: hidden;
      border: 1px solid rgb(255 255 255 / 12%);
      border-radius: 6px;
      padding: 5px 9px;
      color: #f3f5f8;
      background: rgb(21 24 32 / 94%);
      box-shadow: 0 4px 14px rgb(0 0 0 / 30%);
      font: 11px/1.35 ui-monospace, SFMono-Regular, Menlo, monospace;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  `;
  const box = document.createElement('div');
  box.className = 'box';
  const tooltip = document.createElement('div');
  tooltip.className = 'tooltip';
  shadow.append(style, box, tooltip);
  (document.documentElement || document.body).append(host);
  return { host, box, tooltip };
}

function startElementSelection(): Promise<Record<string, unknown>> {
  activePicker?.cancel();

  return new Promise((resolve) => {
    const { host, box, tooltip } = pickerOverlay();
    let hovered: Element | null = null;
    let finished = false;

    const draw = (): void => {
      if (!hovered || !hovered.isConnected) {
        box.style.display = 'none';
        tooltip.style.display = 'none';
        return;
      }

      const rect = hovered.getBoundingClientRect();
      box.style.display = 'block';
      box.style.left = `${rect.left}px`;
      box.style.top = `${rect.top}px`;
      box.style.width = `${rect.width}px`;
      box.style.height = `${rect.height}px`;

      tooltip.textContent = elementLabel(hovered);
      tooltip.style.display = 'block';
      tooltip.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - 368))}px`;
      tooltip.style.top = `${rect.top >= 30 ? rect.top - 27 : Math.min(innerHeight - 25, rect.bottom + 5)}px`;
    };

    const targetFromEvent = (event: Event): Element | null => {
      const pathTarget = event.composedPath()[0];
      if (!(pathTarget instanceof Element)) return null;
      let target: Element = pathTarget;

      // document.querySelector cannot address descendants inside a shadow root.
      // Promote those descendants to the nearest host so the returned selector
      // is something the agent can inspect and use in a page script.
      while (target.getRootNode() instanceof ShadowRoot) {
        target = (target.getRootNode() as ShadowRoot).host;
      }
      return target.closest('[data-scriptsmith-element-picker]') ? null : target;
    };

    const hover = (event: Event): void => {
      const target = targetFromEvent(event);
      if (!target || target === hovered) return;
      hovered = target;
      draw();
    };

    const blockPointerAction = (event: Event): void => {
      hover(event);
      event.preventDefault();
      event.stopImmediatePropagation();
    };

    const cleanup = (): void => {
      document.removeEventListener('pointermove', hover, true);
      document.removeEventListener('pointerdown', blockPointerAction, true);
      document.removeEventListener('mousedown', blockPointerAction, true);
      document.removeEventListener('mouseup', blockPointerAction, true);
      document.removeEventListener('click', select, true);
      document.removeEventListener('keydown', keydown, true);
      window.removeEventListener('scroll', draw, true);
      window.removeEventListener('resize', draw, true);
      host.remove();
      if (activePicker === picker) activePicker = null;
    };

    const finish = (result: Record<string, unknown>): void => {
      if (finished) return;
      finished = true;
      cleanup();
      resolve(result);
    };

    const select = (event: Event): void => {
      blockPointerAction(event);
      if (!hovered) return;
      const html = hovered.outerHTML;
      finish({
        ok: true,
        origin: location.origin,
        element: {
          selector: selectorFor(hovered),
          label: elementLabel(hovered),
          html: html.length <= MAX_SELECTED_HTML
            ? html
            : `${html.slice(0, MAX_SELECTED_HTML)}<!-- truncated -->`,
        },
      });
    };

    const keydown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      finish({ ok: false, cancelled: true, origin: location.origin });
    };

    const picker: ActivePicker = {
      cancel: () => finish({ ok: false, cancelled: true, origin: location.origin }),
    };
    activePicker = picker;
    document.addEventListener('pointermove', hover, true);
    document.addEventListener('pointerdown', blockPointerAction, true);
    document.addEventListener('mousedown', blockPointerAction, true);
    document.addEventListener('mouseup', blockPointerAction, true);
    document.addEventListener('click', select, true);
    document.addEventListener('keydown', keydown, true);
    window.addEventListener('scroll', draw, true);
    window.addEventListener('resize', draw, true);
  });
}

function isPageMessage(value: unknown): value is PageMessage {
  if (!value || typeof value !== 'object') return false;
  const message = value as Record<string, unknown>;
  return (
    message.type === START_SELECTION_MESSAGE ||
    message.type === CANCEL_SELECTION_MESSAGE
  );
}

export default defineContentScript({
  matches: ['<all_urls>'],
  allFrames: true,
  runAt: 'document_idle',
  main() {
    browser.runtime.onMessage.addListener((message: unknown) => {
      if (!isPageMessage(message)) return undefined;

      try {
        if (message.type === START_SELECTION_MESSAGE) return startElementSelection();
        if (message.type === CANCEL_SELECTION_MESSAGE) {
          activePicker?.cancel();
          return Promise.resolve({ ok: true, origin: location.origin });
        }
      } catch (error) {
        return Promise.resolve({
          ok: false,
          origin: location.origin,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
  },
});
