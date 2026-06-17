# Demo Client

This client assembly is source-controlled reference content for local validation.

Run it through Docker Compose from this directory:

```bash
cp .env.example .env
pnpm dev
```

The development stack starts Postgres, S3Mock, the API, the document worker, and the UI. The API listens on `http://127.0.0.1:4100`, the document worker on `http://127.0.0.1:4110`, and the UI on `http://127.0.0.1:5173`.

It registers example tools, including `demo.weather_forecast` and `demo.workflow_summary`.
The weather tool returns `display.kind: "weather.forecast"`, and the demo UI registers
`demoDisplayWidgets` from `widgets/` to render that output.

To exercise the tool path locally, ask for a forecast such as:

```text
Check the weather forecast for Oslo for the next three days.
```
