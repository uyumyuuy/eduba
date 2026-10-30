---
title: プライバシー
description: Eduba での作業データとアクセス情報の取り扱い
---

## PDF と作業データ

ブラウザ版では、PDF の読み込み、OCR、校正、書き出しを利用者の端末内で行います。PDF、画像、OCR の結果、校正内容を Eduba のサーバーやアクセス解析に送信することはありません。

作業コピーはブラウザ内に自動保存されます。ブラウザのサイトデータを削除すると作業コピーも消えるため、必要なプロジェクトは `.eduba` ファイルとして端末に保存してください。保存と削除の方法は[ブラウザ版の使い方](../getting-started/browser/)を参照してください。

## アクセス解析

このドキュメントとブラウザ版アプリでは、利用状況と表示性能を把握するために Cloudflare Web Analytics を使用しています。ページの表示、対応する画面遷移、表示にかかった時間などの情報が Cloudflare に送信されます。Eduba は OCR や校正などの操作を独自のイベントとして送信していません。

Cloudflare は、Web Analytics で個々の利用者をサイト間で追跡しないと説明しています。詳しくは [Cloudflare のデータ収集についての説明](https://developers.cloudflare.com/web-analytics/data-metrics/data-origin-and-collection/)をご覧ください。

## 外部通信

ブラウザ版の起動や OCR の準備には、アプリ本体やモデルなどのファイルをこのサイトから取得します。また、アクセス解析のスクリプトを Cloudflare から読み込み、計測情報を Cloudflare に送信します。デスクトップ版には、このアクセス解析を組み込んでいません。
