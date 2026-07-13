# ワールドマップ YAML 置き場

NPC 配置 UI（WebUI の「マップから選択」）で表示するマップをここに置く。
karakuri-world のワールド定義 YAML（`map.rows` / `map.cols` / `map.nodes` を含むもの）をそのままコピーすればよい。

- `main.yaml` … メインワールド（karakuri-world サーバーの config YAML）
- `<world_id>.yaml` … サブワールド（world 側に登録した world_id とファイル名を揃える）

ファイル名（拡張子を除く）がそのまま world_id として扱われる。
world 側でマップを更新したら、ここの YAML も差し替えること（サーバー再起動は不要）。
