# Demo Client

This client assembly is source-controlled reference content for local validation.

It registers example tools, including `demo.weather_forecast` and `demo.workflow_summary`.
The weather tool returns `domainUi.kind: "weather.forecast"`, and the demo UI registers
`demoDomainUiWidgets` from `widgets/` to render that output.

To exercise the tool path locally, ask for a forecast such as:

```text
Check the weather forecast for Oslo for the next three days.
```
