---
title: PDFs from an App
description: How an App turns HTML into a PDF in the instance's own renderer with the kit's pdf.download and pdf.fromHtml, what the document may contain, and the limits.
---

Part of [Build an App](/apps/build/). An App makes every PDF through the App Kit (kit 1.10.0 and later). The instance prints the HTML in its own renderer, inside the instance: the document never leaves it. Never send a report to an outside PDF service, and do not bundle a PDF library such as jsPDF or html2pdf.

## Making a PDF

```tsx
import { AppCallError, pdf } from "@work-shape/catalyst-app-kit";

async function downloadReport(html: string) {
  try {
    await pdf.download(html, "report.pdf", { format: "A4", margin: { top: "15mm" } });
  } catch (error) {
    if (error instanceof AppCallError) showMessage(error.message);
  }
}
```

`pdf.download(html, filename, options?)` prints the HTML and offers the PDF to the viewer as a download. `pdf.fromHtml(html, options?)` answers the PDF as a `Blob` of type `application/pdf`, for an App that shows or keeps it itself. Both run with the viewer's session; a draft, a Page of a conversation and a published App may all call them. A PDF changes nothing, so it needs no action file.

| Option      | What it does                                                                                                     |
| ----------- | ---------------------------------------------------------------------------------------------------------------- |
| `format`    | `A3`, `A4`, `A5`, `Letter` or `Legal`. Without it a size the HTML names in its own `@page` rule holds, else A4. |
| `landscape` | `true` turns the page. A size in the HTML's own `@page` rule keeps its own orientation.                       |
| `margin`    | `top`, `right`, `bottom`, `left` as CSS lengths such as `15mm`, `1in` or `0`. Each defaults to `12mm`.          |

Backgrounds and colours always print. Page breaks follow CSS: `break-before: page` or `break-inside: avoid`.

## What the document may contain

The renderer has no network. Build one whole HTML document that holds everything it shows:

- Styles in a `<style>` element. The App's own stylesheets and the kit's are not in the document unless the HTML holds them.
- Images, fonts and other files as `data:` addresses. Anything with another address, such as `https://` or a path of the App, stays empty: the renderer blocks every request.
- No scripts: they do not run. Put the finished content into the HTML, and draw charts as inline SVG.

## Limits

| Limit                        | Value                                                    |
| ---------------------------- | -------------------------------------------------------- |
| HTML, `data:` images included | 4 MiB                                                    |
| Pages                        | 50                                                       |
| PDF                          | 10 MiB                                                   |
| Time                         | 20 seconds                                               |
| Calls                        | 10 PDFs a minute per App frame                           |

A larger document is refused, never cut. A call that is refused rejects with an `AppCallError`: `pdf_too_large` or `pdf_too_many_pages` (make images smaller or split the document), `pdf_busy` or `timeout` (try again, or make the document simpler), `rate_limited`, and `pdf_unavailable` where the instance runs no renderer: an administrator switches on the preview-capture service. Show the error's `message` as it is.

Nothing of the document or the PDF is kept or logged: the instance hands the PDF to the App and forgets it.
