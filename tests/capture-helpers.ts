export function captureForm(
  bytes: Uint8Array<ArrayBuffer>,
  pdfUrl: string,
  filename: string,
  titleHint: string,
): FormData {
  const form = new FormData();
  form.set("pdf", new File([bytes], filename, { type: "application/pdf" }));
  form.set("pdf_url", pdfUrl);
  form.set("title_hint", titleHint);
  return form;
}

export function captureDownload(
  path: string,
  pdfUrl: string,
  filename: string,
  titleHint: string,
): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, pdf_url: pdfUrl, filename, title_hint: titleHint }),
  };
}
