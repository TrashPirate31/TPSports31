# TPSports31 plugin for Kino

A plugin for the Kino video app that brings the live events and TV channels of
[streamed.pk](https://streamed.pk) into Kino's search, Home and player. It is the reference example
for plugin authors: one manifest, one JavaScript file, no build step.

## What it does

Get the streams from 'streamed.pk' and add them to Kino, allowing you to enjoy live sporting events

## Your own addresses (Configurar)

Under Ajustes > Plugins > TPSports31 > Configurar the person can add up to thirty streamed.pk
addresses with the "Agregar" button (a dialog with Dirección and an optional Categoría); each one is then listed as a text line with an "Editar" button:

## Install it in Kino

In Kino open Ajustes > Plugins and type the address of this repository:

```
kinotvapp/kino-plugin-archive
```

Kino reads `kino-plugin.json` and `plugin.js` from the repository root, shows the hosts the plugin
will reach and asks for approval before anything runs.

## Write your own plugin

This repository is also the starting point for your own plugin:

- [`GUIDE.md`](GUIDE.md) is the authoring guide: file layout, manifest and settings, the five
  functions your code can export, the `kino` API, every limit, the quirks of the JavaScript engine
  and five cookbook recipes.
- [`contract.json`](contract.json) holds every number and rule Kino enforces, and
  [`kino.d.ts`](kino.d.ts) declares the `kino` API for your editor.
- [`sdk/`](sdk) lets you run and test a plugin on your computer with Node 18 or newer, using the same
  `kino` API as the app and checking what you return the way Kino does:

```
node sdk/run.mjs ./plugin.js search "metropolis"
node sdk/run.mjs ./plugin.js home
node sdk/run.mjs ./plugin.js browse films 2
node sdk/validate.mjs .
node sdk/init.mjs ../my-plugin --host example.com
```

Copy `plugin.js` and `kino-plugin.json`, change them, and publish your repository the same way.

## License

The code in this repository is licensed under the [Apache License 2.0](LICENSE). Copyright 2026 kinotvapp.

## License note

What this plugin plays is not ours to license: the streams can be found publicly
their uploader chose on streamed.pk. Check an item's page before you reuse or redistribute it.
