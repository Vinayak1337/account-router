// Keep live buttons and cards in the DOM: a status tick must not swallow a click,
// clear keyboard focus, or move the viewport back to a previously focused control.
export function nodeKey(node) {
  return node.nodeType === 1
    ? node.id ||
        node.dataset.account ||
        node.dataset.key ||
        node.tagName + ":" + (node.getAttribute("class") || "")
    : "#text";
}
export function reconcileChildren(parent, desired) {
  const unused = new Set(parent.childNodes);
  let cursor = parent.firstChild;
  for (const fresh of desired) {
    const current = [...unused].find(
      (node) =>
        node.nodeType === fresh.nodeType &&
        node.nodeName === fresh.nodeName &&
        nodeKey(node) === nodeKey(fresh),
    );
    const node = current || fresh;
    if (current) {
      unused.delete(current);
      if (current.nodeType === 3) {
        if (current.data !== fresh.data) current.data = fresh.data;
      } else {
        const expanded = current.tagName === "DETAILS" && current.open;
        for (const attr of [...current.attributes])
          if (!fresh.hasAttribute(attr.name))
            current.removeAttribute(attr.name);
        for (const attr of fresh.attributes)
          if (current.getAttribute(attr.name) !== attr.value)
            current.setAttribute(attr.name, attr.value);
        reconcileChildren(current, [...fresh.childNodes]);
        if (expanded) current.open = true;
      }
    }
    if (node !== cursor) parent.insertBefore(node, cursor);
    cursor = node.nextSibling;
  }
  for (const node of unused) node.remove();
}
export function keepViewport(action) {
  const x = window.scrollX,
    y = window.scrollY;
  action();
  if (window.scrollX !== x || window.scrollY !== y)
    window.scrollTo({ left: x, top: y, behavior: "instant" });
}
export function elem(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}
