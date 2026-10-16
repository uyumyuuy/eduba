import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  site: 'https://uyumyuuy.github.io',
  base: '/eduba',
  trailingSlash: 'always',
  integrations: [
    starlight({
      title: 'Eduba',
      description: 'スキャンした本のOCRを確認し、校正して書き出すアプリ',
      locales: { root: { label: '日本語', lang: 'ja' } },
      sidebar: [
        { label: 'はじめに', items: ['index', 'getting-started/browser', 'getting-started/installation', 'getting-started/first-project'] },
        { label: '使い方', items: ['guides/importing', 'guides/ocr', 'guides/proofreading', 'guides/regions', 'guides/exporting', 'guides/replace-all'] },
        { label: '困ったとき', items: ['troubleshooting'] },
      ],
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/uyumyuuy/eduba' }],
    }),
  ],
});




