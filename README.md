# Web Pipe VS Code Extension

The easiest way to ship this extension is to package a `.vsix` file and share that artifact directly.

This extension provides:

- syntax highlighting for `.wp` files
- diagnostics, hovers, completions, and other language-server features
- a `webpipe` debug configuration for VS Code
- a `webpipe-lsp` CLI for terminal diagnostics

## Install `webpipe`

The extension looks for a `webpipe` binary in `PATH` first, then in common local build locations such as `webpipe/target/release/webpipe` and `target/release/webpipe`.

The simplest install path is Homebrew:

```bash
brew tap williamcotton/webpipe
brew install webpipe
```

## CLI Diagnostics

This package also ships a terminal diagnostics command:

```bash
webpipe-lsp check app.wp
webpipe-lsp check app.wp --json
```

For local development from this repo:

```bash
npm ci
npm run compile
npm run check -- ../webpipe/example.wp
```

If you want the `webpipe-lsp` command available in your shell from a local clone:

```bash
npm ci
npm run compile
npm link
```

If this package is published to npm, users can install it globally and get the same `webpipe-lsp` command from their `PATH`.

## Build And Ship A VSIX

From this directory:

```bash
npm ci
npm run package
```

That produces a file named `webpipe-<version>.vsix` in `webpipe-lsp/`.

To install it locally in VS Code:

```bash
code --install-extension webpipe-<version>.vsix --force
```

If you do not have the `code` CLI installed, use `Extensions: Install from VSIX...` inside VS Code.

## Develop Locally

```bash
npm ci
npm run watch
```

Then open `webpipe-lsp/` in VS Code and press `F5` to launch an Extension Development Host.

## Screenshots

### Unknown Route

![webpipe-lsp-unknown-route](https://github.com/user-attachments/assets/c0245a57-40ba-4329-95b7-e0db8b973d0a)

### Hover

![webpipe-lsp-hover](https://github.com/user-attachments/assets/a151f2df-d28e-4490-906e-3e2b44a260bc)

### Handlebars

![webpipe-lsp-handlebars-partials](https://github.com/user-attachments/assets/1fc82507-5c74-46dd-87b0-43937c3a666f)

### Let Variables

![webpipe-lsp-let-variable](https://github.com/user-attachments/assets/0b6d5b6c-3469-4875-bbc1-e47bf6bfa9a7)

### DOM Selectors

![webpipe-lsp-pipeline-selectors](https://github.com/user-attachments/assets/164d5397-83c1-49ff-bcf8-4ece945036c9)
