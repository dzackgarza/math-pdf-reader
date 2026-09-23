// Values baked in at build time from pdf-bucket.config.json (define in wxt.config.ts).
declare const PDF_BUCKET_BUILD: {
  bucketOrigin: string;
  minFrameWidth: number;
  minFrameHeight: number;
};

export const bucketBuild = PDF_BUCKET_BUILD;
