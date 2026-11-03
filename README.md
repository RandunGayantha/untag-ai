# UnTag.ai

Browser-based tool to strip EXIF, XMP, IPTC and C2PA / AI metadata from images. No uploads, no backend, no dependencies.

## Features
- Removes EXIF (incl. GPS), XMP, IPTC / Photoshop blocks, JPEG comments
- Removes C2PA / Content Credentials (JPEG APP11, PNG `caBX`, WebP `C2PA`)
- Removes AI generation parameters in PNG text chunks (`parameters`, `prompt`, `workflow`, …)
- **Lossless mode** for JPEG / PNG / WebP – pixels are not touched
- **Re-encode mode** for any browser-decodable format
- Batch processing and ZIP download

## Run
Open `index.html` in a browser, or serve the folder with any static server
(GitHub Pages, Netlify, `npx serve`).

## Limits
Only embedded metadata is removed. Invisible pixel watermarks (e.g. SynthID) and
classifier-based detection are **not** affected. Many platforms require you to
disclose realistic AI-generated content yourself – follow their policies.

## License
MIT
