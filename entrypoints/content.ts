const INSPECT_MESSAGE = 'vibext:inspect-elements';
const FIND_MESSAGE = 'vibext:find-elements';
const MAX_RESULTS = 10;
const MAX_SCANNED_ELEMENTS = 20_000;
const MAX_HTML_PER_RESULT = 6_000;
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

type PageMessage = InspectionMessage | FindMessage;

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
    (message.type === FIND_MESSAGE && typeof message.query === 'string')
  );
}

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  main() {
    browser.runtime.onMessage.addListener((message: unknown) => {
      if (!isPageMessage(message)) return undefined;

      try {
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
