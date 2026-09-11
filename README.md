# world-magnet テストビルド

`Saitwo/world-magnet` フェーズ0プロトタイプの配布用。ここには**ビルド成果物だけ**を置く。
企画ドキュメント・変換スクリプト・テストは本体リポ（非公開）にある。

更新は本体リポで `./scripts/deploy-test.sh`。

- 公開URL: https://saitwo.github.io/world-magnet-test/
- 合言葉が要る（本体リポの `index.html` の `GATE_PW`）
- `noindex` ＋ `robots.txt` で検索からは外してある。通りすがり対策であって機密保護ではない
- マグネットの画像は閲覧者の端末（IndexedDB）にしか保存されない。サーバーには送られない
