// Swagger UI for the project's OpenAPI specs (docs/openapi/), served at /docs.
// A plain HTML page outside the app layout; Swagger UI comes from a pinned CDN build.
const SWAGGER_UI = "https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.17.14";

const SPECS = [
  { name: "Customer gateway", file: "customer-api" },
  { name: "Main API", file: "main-api" },
  { name: "Rust backend", file: "backend" },
  { name: "Investigator API", file: "investigator-api" },
];

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Sniffer API docs</title>
  <link rel="stylesheet" href="${SWAGGER_UI}/swagger-ui.css">
  <style>body { margin: 0; background: #fff; }</style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="${SWAGGER_UI}/swagger-ui-bundle.js"></script>
  <script src="${SWAGGER_UI}/swagger-ui-standalone-preset.js"></script>
  <script>
    window.ui = SwaggerUIBundle({
      urls: ${JSON.stringify(SPECS.map(({ name, file }) => ({ name, url: `/docs/openapi/${file}.yaml` })))},
      "urls.primaryName": "Customer gateway",
      dom_id: "#swagger-ui",
      deepLinking: true,
      presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
      layout: "StandaloneLayout",
    });
  </script>
</body>
</html>`;

export function GET() {
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}
