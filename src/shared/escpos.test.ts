import { describe, expect, test } from "vitest";
import { DRAWER_KICK, rasterImage, receiptJob } from "./escpos";

/** A 4-byte-per-pixel image, all white except the given black pixels. */
function image(width: number, height: number, black: [number, number][]) {
  const data = new Uint8Array(width * height * 4).fill(255);
  for (const [x, y] of black) data.fill(0, (y * width + x) * 4, (y * width + x) * 4 + 3);
  return { width, height, data };
}

describe("ESC/POS raster", () => {
  test("packs pixels into bits, most significant first, one row after another", () => {
    const bytes = rasterImage(image(16, 2, [[0, 0], [7, 0], [8, 1], [15, 1]]));

    // GS v 0, mode 0, 2 bytes per row, 2 rows
    expect([...bytes.subarray(0, 8)]).toEqual([0x1d, 0x76, 0x30, 0x00, 2, 0, 2, 0]);
    expect([...bytes.subarray(8)]).toEqual([0b10000001, 0, 0, 0b10000001]);
  });

  test("pads a width that is not a multiple of 8 and treats light grey as white", () => {
    const img = image(10, 1, [[9, 0]]);
    img.data.fill(200, 0, 3);

    const bytes = rasterImage(img);

    expect([...bytes.subarray(4, 6)]).toEqual([2, 0]);
    expect([...bytes.subarray(8)]).toEqual([0, 0b01000000]);
  });

  test("splits tall images into bands the printer accepts", () => {
    const bytes = rasterImage(image(8, 600, []), 256);

    const headers = [...bytes].flatMap((b, i) => (b === 0x1d && bytes[i + 1] === 0x76 && bytes[i + 2] === 0x30 ? [i] : []));
    expect(headers).toHaveLength(3);
    expect(bytes.length).toBe(3 * 8 + 600);
  });

  test("a receipt job initialises, prints, feeds, cuts, and kicks the drawer only when asked", () => {
    const img = image(8, 1, []);

    const withDrawer = receiptJob(img, { openDrawer: true });
    const without = receiptJob(img, { openDrawer: false });

    expect([...withDrawer.subarray(0, 2)]).toEqual([0x1b, 0x40]);
    expect([...withDrawer.subarray(-5)]).toEqual([...DRAWER_KICK]);
    expect([...without.subarray(-4)]).toEqual([0x1d, 0x56, 0x42, 0x00]);
  });
});
