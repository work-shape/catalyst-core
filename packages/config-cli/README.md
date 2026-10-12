# Catalyst CLI

`catalyst` is the command line tool for a Workshape Catalyst instance. It synchronizes agents and skills between a folder and an instance.

```sh
npm install --global @work-shape/catalyst-cli
catalyst --help
```

It needs Node 22 or later. The key is read from `CATALYST_API_KEY`, is sent only to the instance you name over HTTPS, and is never written into the working copy.

MIT licence.
