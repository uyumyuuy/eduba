import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  site: 'https://eduba.kurnugia.com',
  trailingSlash: 'always',
  integrations: [
    starlight({
      title: 'Eduba',
      description: 'スキャンした本のOCRを確認し、校正して書き出すアプリ',
      locales: { root: { label: '日本語', lang: 'ja' } },
      head: [{ tag: 'script', attrs: {
        type: 'module',
        src: 'https://static.cloudflareinsights.com/beacon.min.js',
        'data-cf-beacon': JSON.stringify({ token: 'ac0248e137a945d78a0d7a30aafad910' }),
      } }],
      sidebar: [
        { label: 'はじめに', items: ['index', 'getting-started/browser', 'getting-started/installation', 'getting-started/first-project'] },
        { label: '使い方', items: ['guides/importing', 'guides/working-projects', 'guides/ocr', 'guides/proofreading', 'guides/reading', 'guides/regions', 'guides/exporting', 'guides/replace-all'] },
        { label: '困ったとき', items: ['troubleshooting'] },
        { label: 'プライバシー', items: ['privacy'] },
      ],
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/uyumyuuy/eduba' }],
    }),
  ],
});




