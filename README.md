# smollog

> Minimal decentralized journal & blog powered by [Zen Entropy Network](https://delay.scobrudot.dev/zen).

## Overview

`smollog` is a zero-backend, cryptographic blogging application built on top of Zen P2P graph database.

- **Dynamic Multi-User Routing**: Access any author's journal directly via `smollog.vercel.app/<pub>` (or `?author=<pub>`). When logging in, the URL updates automatically so authors can share their personal blog link.
- **Offline-First & P2P**: Data is stored and synchronized over Zen relays.
- **Cryptographic Ownership**: Secp256k1 keypair derived deterministically via PBKDF2 (`DEFAULT_SALT_PREFIX`). Only the key holder can sign and write to their author namespace.
- **Minimalist Markdown**: Supports clean markdown rendering with code highlighting, tables, quotes, and links.
- **Dual Theme**: Monospace aesthetic with dark and light mode toggle.

## Development

To run locally:

```bash
npx serve .
```

## Deployment

Deployable to Vercel or any static host:

```bash
npx vercel --prod
```

## License

MIT
