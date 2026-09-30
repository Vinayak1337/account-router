const paths = {
  refresh:
    "M20 7v5h-5 M4 17v-5h5 M6 8a7 7 0 0 1 11-3l3 3 M18 16a7 7 0 0 1-11 3l-3-3",
  plus: "M12 5v14 M5 12h14",
  close: "M6 6l12 12 M18 6L6 18",
  up: "M6 14l6-6 6 6",
  down: "M6 10l6 6 6-6",
  repeat: "M4 9h15l-3-3 M20 15H5l3 3",
  check: "M5 12l4 4L19 6",
  theme: "M12 3a9 9 0 1 0 0 18V3z",
  grip: "M8 5h.01 M16 5h.01 M8 12h.01 M16 12h.01 M8 19h.01 M16 19h.01",
  connect: "M8 4v5 M16 4v5 M6 9h12v3a6 6 0 0 1-12 0z M12 18v3",
};
export function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", name === "grip" ? "3" : "1.9");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", "icon");
  const path = document.createElementNS(svg.namespaceURI, "path");
  path.setAttribute("d", paths[name] || paths.check);
  svg.append(path);
  return svg;
}
export function iconLabel(button, name, label) {
  button.replaceChildren(icon(name));
  if (label) {
    const span = document.createElement("span");
    span.textContent = label;
    button.append(span);
  }
}
