import { z } from "zod";
import { expectPageRan, openPage } from "./page-fixtures";
import { expect, test } from "./test";

// The picture a run asks of a preview (PREVIEW-SEE-1) is taken in the browser that shows it:
// the platform's guard in the Page draws the document into a canvas through an SVG
// `foreignObject` and answers the interface's window with WebP bytes. Here the window that
// holds the frame asks as the interface does, from a real Page the instance serves, wider than
// a picture may be. The picture is a WebP within the bounds, and shows the Page: the red of a
// canvas the Page drew, the green of an image file it loaded and the blue of a box it styled.
// Fails without the guard's capture script: nothing answers.

const CAPTURE_MAX_BYTES = 400_000;

const answerSchema = z.object({
  unavailable: z.boolean(),
  bytes: z.number(),
  header: z.string(),
  width: z.number(),
  height: z.number(),
  decodedWidth: z.number(),
  decodedHeight: z.number(),
  red: z.number(),
  green: z.number(),
  blue: z.number()
});

test("the guard draws the Page it holds into a WebP picture within the bounds", async ({
  page
}) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1500, height: 900 });
  const frame = await openPage(page, {
    html: [
      '<div style="display:flex;gap:24px;padding:24px;align-items:flex-start">',
      '<canvas id="chart" width="200" height="120" style="width:200px;height:120px"></canvas>',
      '<img src="./assets/mark.svg" alt="" style="width:120px;height:120px">',
      '<div style="width:160px;height:120px;background:rgb(0,0,255)"></div>',
      "</div>",
      "<p>Umsatz je Monat</p>"
    ].join(""),
    script: [
      'const chart = document.getElementById("chart").getContext("2d");',
      'chart.fillStyle = "rgb(255,0,0)";',
      "chart.fillRect(0, 0, 200, 120);",
      'document.body.setAttribute("data-drawn", "true");'
    ].join("\n"),
    files: {
      "assets/mark.svg":
        '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><rect width="120" height="120" fill="rgb(0,255,0)"/></svg>'
    }
  });
  await expectPageRan(page);
  await expect(frame.locator("body")).toHaveAttribute("data-drawn", "true");

  const answer = answerSchema.parse(
    await page.evaluate(async () => {
      const holder = window.frames[0];
      const pageWindow = holder?.[0];
      if (!pageWindow) throw new Error("No Page frame");
      const answered = new Promise<object>((resolve) => {
        window.addEventListener("message", (event: MessageEvent<unknown>) => {
          const data = event.data;
          if (
            event.source === pageWindow &&
            typeof data === "object" &&
            data !== null &&
            Reflect.get(data, "type") === "capture_result" &&
            Reflect.get(data, "requestId") === "capture-1"
          ) {
            resolve(data);
          }
        });
      });
      pageWindow.postMessage({ catalystBridge: 1, type: "capture", requestId: "capture-1" }, "*");
      const data = await answered;
      const image: unknown = Reflect.get(data, "image");
      if (!(image instanceof ArrayBuffer)) {
        return {
          unavailable: true,
          bytes: 0,
          header: "",
          width: 0,
          height: 0,
          decodedWidth: 0,
          decodedHeight: 0,
          red: 0,
          green: 0,
          blue: 0
        };
      }
      const bytes = new Uint8Array(image);
      const header =
        String.fromCharCode(...bytes.subarray(0, 4)) +
        String.fromCharCode(...bytes.subarray(8, 12));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/webp" }));
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext("2d");
      if (!context) throw new Error("No canvas");
      context.drawImage(bitmap, 0, 0);
      const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
      let red = 0;
      let green = 0;
      let blue = 0;
      for (let at = 0; at < pixels.length; at += 4) {
        const [r = 0, g = 0, b = 0] = [pixels[at], pixels[at + 1], pixels[at + 2]];
        if (r > 200 && g < 60 && b < 60) red += 1;
        if (g > 200 && r < 60 && b < 60) green += 1;
        if (b > 200 && r < 60 && g < 60) blue += 1;
      }
      return {
        unavailable: false,
        bytes: bytes.byteLength,
        header,
        width: Number(Reflect.get(data, "width")),
        height: Number(Reflect.get(data, "height")),
        decodedWidth: bitmap.width,
        decodedHeight: bitmap.height,
        red,
        green,
        blue
      };
    })
  );

  expect(answer.unavailable).toBe(false);
  expect(answer.header).toBe("RIFFWEBP");
  expect(answer.bytes).toBeLessThanOrEqual(CAPTURE_MAX_BYTES);
  // The frame is 1500 pixels wide: the picture is scaled to the widest a picture may be.
  expect(answer.width).toBe(1280);
  expect(answer.height).toBeLessThanOrEqual(1600);
  expect([answer.decodedWidth, answer.decodedHeight]).toEqual([answer.width, answer.height]);
  // Each box is drawn at about 0.85 of its size, so it covers thousands of pixels.
  expect(answer.red).toBeGreaterThan(5_000);
  expect(answer.green).toBeGreaterThan(5_000);
  expect(answer.blue).toBeGreaterThan(5_000);
});
