import type { ResponseHeader } from "../../src/extension/interception";

export type CaptureCase = {
  name: string;
  url: string;
  headers: ResponseHeader[];
  eligible: boolean;
};

export const captureCases: CaptureCase[] = [
  {
    name: "PDF MIME",
    url: "https://example.test/paper",
    headers: [{ name: "Content-Type", value: "application/pdf" }],
    eligible: true,
  },
  {
    name: "case-insensitive PDF path",
    url: "https://example.test/PAPER.PDF?download=1",
    headers: [{ name: "Content-Type", value: "application/octet-stream" }],
    eligible: true,
  },
  {
    name: "disposition filename",
    url: "https://example.test/download?id=paper",
    headers: [
      { name: "Content-Type", value: "binary/octet-stream" },
      { name: "Content-Disposition", value: 'attachment; filename="paper.pdf"' },
    ],
    eligible: true,
  },
  {
    name: "ordinary HTML",
    url: "https://example.test/paper",
    headers: [{ name: "Content-Type", value: "text/html" }],
    eligible: false,
  },
];
