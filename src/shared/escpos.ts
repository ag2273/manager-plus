/**
 * ESC/POS commands for 80 mm thermal printers. The receipt is drawn by Chromium and
 * sent as a 1-bit raster image, so Arabic prints correctly whatever fonts the printer has.
 */

/** Pixels, 4 bytes each (RGBA or BGRA: only the average of the first three is used). */
export type Bitmap = { width: number; height: number; data: Uint8Array };

const INIT = [0x1b, 0x40];
/** Feed a few lines, then a partial cut. */
const FEED_AND_CUT = [0x1d, 0x56, 0x42, 0x00];
/** Pulse drawer pin 2 for 50 ms on, 500 ms off. */
export const DRAWER_KICK = Uint8Array.from([0x1b, 0x70, 0x00, 0x19, 0xfa]);

/** Many printers refuse taller raster blocks than this. */
const BAND = 256;
const DARK = 128;

/** `GS v 0` raster blocks for the image, split into bands of at most `band` rows. */
export function rasterImage(image: Bitmap, band = BAND): Uint8Array {
  const rowBytes = Math.ceil(image.width / 8);
  const chunks: number[] = [];
  for (let top = 0; top < image.height; top += band) {
    const rows = Math.min(band, image.height - top);
    chunks.push(0x1d, 0x76, 0x30, 0x00, rowBytes & 0xff, rowBytes >> 8, rows & 0xff, rows >> 8);
    for (let y = top; y < top + rows; y++) {
      for (let byte = 0; byte < rowBytes; byte++) {
        let bits = 0;
        for (let bit = 0; bit < 8; bit++) {
          const x = byte * 8 + bit;
          if (x >= image.width) continue;
          const i = (y * image.width + x) * 4;
          const light = (image.data[i]! + image.data[i + 1]! + image.data[i + 2]!) / 3;
          if (light < DARK) bits |= 0x80 >> bit;
        }
        chunks.push(bits);
      }
    }
  }
  return Uint8Array.from(chunks);
}

/** A whole print job: reset, the image, feed and cut, and the drawer kick for cash sales. */
export function receiptJob(image: Bitmap, options: { openDrawer: boolean }): Uint8Array {
  const raster = rasterImage(image);
  const parts = [Uint8Array.from(INIT), raster, Uint8Array.from(FEED_AND_CUT), options.openDrawer ? DRAWER_KICK : new Uint8Array()];
  const out = new Uint8Array(parts.reduce((t, p) => t + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
