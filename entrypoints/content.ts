const INSPECT_MESSAGE = 'vibext:inspect-elements';
const FIND_MESSAGE = 'vibext:find-elements';
const START_SELECTION_MESSAGE = 'vibext:start-element-selection';
const CANCEL_SELECTION_MESSAGE = 'vibext:cancel-element-selection';
const MAX_RESULTS = 10;
const MAX_SCANNED_ELEMENTS = 20_000;
const MAX_HTML_PER_RESULT = 6_000;
const MAX_SELECTED_HTML = 2_000;
const SEMANTIC_TARGETS = [
  'a',
  'button',
  'input',
  'select',
  'textarea',
  'label',
  'summary',
  '[role="button"]',
  '[role="link"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="tab"]',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
].join(',');

interface InspectionMessage {
  type: typeof INSPECT_MESSAGE;
  selector: string;
}

interface FindMessage {
  type: typeof FIND_MESSAGE;
  query: string;
}

interface StartSelectionMessage {
  type: typeof START_SELECTION_MESSAGE;
}

interface CancelSelectionMessage {
  type: typeof CANCEL_SELECTION_MESSAGE;
}

type PageMessage =
  | InspectionMessage
  | FindMessage
  | StartSelectionMessage
  | CancelSelectionMessage;

function comment(value: string): string {
  return value.replaceAll('--', '—').replaceAll('>', '&gt;');
}

function normalizedText(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

function pseudoContent(element: Element, pseudo: '::before' | '::after'): string {
  const style = getComputedStyle(element, pseudo);
  const content = style.content;
  if (!content || content === 'none' || content === 'normal') return '';

  // Browsers generally expose generated text as a quoted CSS string. This is
  // intentionally a small decoder rather than a CSS parser: its purpose is to
  // make ordinary generated labels and emoji visible to inspection.
  const unquoted =
    (content.startsWith('"') && content.endsWith('"')) ||
    (content.startsWith("'") && content.endsWith("'"))
      ? content.slice(1, -1)
      : content;
  return normalizedText(
    unquoted
      .replace(/\\A\s?/gi, '\n')
      .replace(/\\(["'\\])/g, '$1'),
  );
}

function renderedContentComments(element: Element): string[] {
  const comments: string[] = [];
  for (const pseudo of ['::before', '::after'] as const) {
    const content = pseudoContent(element, pseudo);
    if (content) comments.push(`<!-- rendered ${pseudo}: ${comment(content)} -->`);
  }
  return comments;
}

function isVisible(element: Element): boolean {
  for (let current: Element | null = element; current; current = current.parentElement) {
    if (current.hasAttribute('hidden') || current.getAttribute('aria-hidden') === 'true') {
      return false;
    }
    const style = getComputedStyle(current);
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.visibility === 'collapse'
    ) {
      return false;
    }
  }
  return true;
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

function htmlResults(
  heading: string,
  elements: Element[],
  total: number,
  extra = '',
): string {
  const lines = [
    `<!-- ${comment(heading)} -->`,
    `<!-- URL: ${comment(location.href)} -->`,
    `<!-- ${total} match${total === 1 ? '' : 'es'}; showing ${elements.length}${total > elements.length ? '; results truncated' : ''} -->`,
  ];
  if (extra) lines.push(`<!-- ${comment(extra)} -->`);

  elements.forEach((element, index) => {
    const html = element.outerHTML;
    lines.push(
      '',
      `<!-- match ${index + 1}; selector: ${comment(selectorFor(element))} -->`,
      ...renderedContentComments(element),
      html.length <= MAX_HTML_PER_RESULT
        ? html
        : `<!-- outerHTML omitted: ${html.length} characters; inspect a narrower selector -->`,
    );
  });
  return lines.join('\n');
}

function inspectElements(selector: string): string {
  let matches: Element[];
  try {
    matches = Array.from(document.querySelectorAll(selector));
  } catch (error) {
    throw new Error(
      `Invalid CSS selector: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return htmlResults(
    `inspect_elements selector: ${selector}`,
    matches.slice(0, MAX_RESULTS),
    matches.length,
  );
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
  host.setAttribute('data-vibext-element-picker', '');
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
      border: 2px solid #2563eb;
      border-radius: 3px;
      background: rgb(37 99 235 / 16%);
      box-shadow: 0 0 0 1px rgb(255 255 255 / 75%);
    }
    .tooltip {
      position: fixed;
      display: none;
      max-width: min(360px, calc(100vw - 16px));
      overflow: hidden;
      border-radius: 4px;
      padding: 4px 7px;
      color: white;
      background: #172033;
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
      return target.closest('[data-vibext-element-picker]') ? null : target;
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

function searchableValues(element: Element): string[] {
  const values = [
    element.getAttribute('aria-label'),
    element.getAttribute('title'),
    element.getAttribute('alt'),
    element.getAttribute('placeholder'),
    element.getAttribute('name'),
  ];
  if (
    element instanceof HTMLButtonElement ||
    (element instanceof HTMLInputElement && ['button', 'submit', 'reset'].includes(element.type))
  ) {
    values.push(element.value);
  }
  values.push(
    element.textContent,
    pseudoContent(element, '::before'),
    pseudoContent(element, '::after'),
  );
  return values.map(normalizedText).filter(Boolean);
}

function preferredTarget(element: Element): Element {
  const semantic = element.closest(SEMANTIC_TARGETS);
  return semantic && semantic.contains(element) ? semantic : element;
}

function findElements(query: string): string {
  const needle = normalizedText(query).toLocaleLowerCase();
  if (!needle) throw new Error('find_elements requires a non-empty query.');

  const candidates: Element[] = [];
  let scanned = 0;
  for (const element of Array.from(document.body?.querySelectorAll('*') ?? [])) {
    scanned += 1;
    if (scanned > MAX_SCANNED_ELEMENTS) break;
    if (!isVisible(element)) continue;
    if (
      searchableValues(element).some((value) =>
        value.toLocaleLowerCase().includes(needle),
      )
    ) {
      candidates.push(element);
    }
  }

  // textContent makes every ancestor of a textual hit match. Keep the most
  // specific hits, then promote nested text to a useful control or heading.
  const candidateSet = new Set(candidates);
  const candidatesWithMatchingDescendants = new Set<Element>();
  for (const candidate of candidates) {
    for (let ancestor = candidate.parentElement; ancestor; ancestor = ancestor.parentElement) {
      if (candidateSet.has(ancestor)) candidatesWithMatchingDescendants.add(ancestor);
    }
  }
  const specific = candidates.filter(
    (candidate) => !candidatesWithMatchingDescendants.has(candidate),
  );
  const unique: Element[] = [];
  for (const candidate of specific) {
    const target = preferredTarget(candidate);
    if (!unique.includes(target)) unique.push(target);
  }

  return htmlResults(
    `find_elements query: ${query}`,
    unique.slice(0, MAX_RESULTS),
    unique.length,
    scanned > MAX_SCANNED_ELEMENTS
      ? `Search stopped after ${MAX_SCANNED_ELEMENTS} elements`
      : `Searched ${scanned} elements`,
  );
}

function isPageMessage(value: unknown): value is PageMessage {
  if (!value || typeof value !== 'object') return false;
  const message = value as Record<string, unknown>;
  return (
    (message.type === INSPECT_MESSAGE && typeof message.selector === 'string') ||
    (message.type === FIND_MESSAGE && typeof message.query === 'string') ||
    message.type === START_SELECTION_MESSAGE ||
    message.type === CANCEL_SELECTION_MESSAGE
  );
}

export default defineContentScript({
  matches: ['<all_urls>'],
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

        return Promise.resolve({
          ok: true,
          origin: location.origin,
          html: message.type === INSPECT_MESSAGE
            ? inspectElements(message.selector)
            : findElements(message.query),
        });
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
