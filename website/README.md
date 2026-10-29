# Eduba Website

日本語ドキュメントサイトは Astro Starlight で構成しています。
`https://eduba.kurnugia.com/` にドキュメント、`/app/` にブラウザ版を配信します。

## サイト全体のビルド

リポジトリのルートで実行します。Node.js 24 と GitHub CLI が必要です。

```powershell
npm ci
npm ci --prefix website
npm run build:website
npm --prefix website run preview -- --host 127.0.0.1
```

固定した OCR モデルを Release から取得して検証し、アプリを `public/app/` に配置した後、
Astro をビルドします。配信するのは `website/dist/` 全体です。
`public/app/` は生成物なので直接編集しません。
初回のモデル公開やローカルファイルからのモデル準備は [サイト公開手順](../docs/website-deployment.md) を参照してください。

## ドキュメントだけを編集する

このディレクトリで実行します。`npm run dev` はブラウザ版をビルドしません。

- `npm ci` で依存関係を復元します。
- `npm run dev` でローカルプレビューを起動します。
- `npm run build` で `dist/` に静的サイトを生成します。
- `src/content/docs/getting-started/` に導入と最初の操作、`src/content/docs/guides/` に各機能の使い方、`src/content/docs/troubleshooting.mdx` に問題解決を記載します。

`main` ブランチへサイトの変更を push すると GitHub Actions が GitHub Pages に公開します。最初の公開前に、GitHub リポジトリの **Settings → Pages → Build and deployment → Source** を **GitHub Actions** に設定してください。

