import qrcode from "qrcode-generator";

/** A QR code as an SVG of black squares, the same every time for the same text; sized for an 80 mm receipt. */
export function qrSvg(text: string, size = 240): string {
  const code = qrcode(0, "M");
  code.addData(text, "Byte");
  code.make();
  const count = code.getModuleCount();
  const quiet = 4;
  const cells: string[] = [];
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) if (code.isDark(row, col)) cells.push(`M${col + quiet} ${row + quiet}h1v1h-1z`);
  }
  const side = count + quiet * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${side} ${side}" shape-rendering="crispEdges"><rect width="${side}" height="${side}" fill="#fff"/><path fill="#000" d="${cells.join("")}"/></svg>`;
}
