"""アイコン生成スクリプト: ストップウォッチ風のシンプルなアイコンを 16/48/128px で生成"""
from PIL import Image, ImageDraw

# ブランドカラー (オーバーレイのアクセント色に合わせる)
BG_DARK = (17, 20, 28, 255)       # #11141c
ACCENT = (29, 78, 216, 255)        # #1d4ed8 (プライマリーボタン)
FACE = (245, 246, 250, 255)        # ほぼ白
HAND = (29, 78, 216, 255)          # ハンド色
TICK = (17, 20, 28, 255)           # 目盛
BUTTON = (245, 213, 74, 255)       # ストップウォッチ上部のボタン (#ffd54a 系)

def draw_icon(size: int) -> Image.Image:
    """指定サイズの正方形アイコンを生成する。
    内部は 4x の解像度で描画してからアンチエイリアス付きで縮小する。
    """
    scale = 4
    s = size * scale
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # 全体の余白
    pad = int(s * 0.06)
    cx = s // 2
    # 上部のクラウン(押しボタン)とベルが小さくならないように
    top_extra = int(s * 0.10)
    bottom_pad = pad
    body_top = pad + top_extra
    body_bottom = s - bottom_pad
    body_size = body_bottom - body_top
    radius = body_size // 2
    cy = body_top + radius

    # 上部の小さなクラウン (左右の耳)
    crown_h = int(s * 0.06)
    crown_w = int(radius * 0.55)
    crown_top = body_top - crown_h
    # 中央のボタン (押しボタン)
    btn_w = int(radius * 0.42)
    btn_h = int(s * 0.09)
    btn_top = crown_top - int(btn_h * 0.5)
    btn_left = cx - btn_w // 2
    btn_right = cx + btn_w // 2
    draw.rounded_rectangle(
        [btn_left, btn_top, btn_right, crown_top + crown_h],
        radius=max(2, int(s * 0.02)),
        fill=BUTTON,
    )

    # 本体 (背景)
    draw.ellipse(
        [cx - radius, cy - radius, cx + radius, cy + radius],
        fill=BG_DARK,
    )

    # 文字盤
    face_r = int(radius * 0.86)
    draw.ellipse(
        [cx - face_r, cy - face_r, cx + face_r, cy + face_r],
        fill=FACE,
    )

    # 12/3/6/9 の目盛 (短い太線)
    tick_len = max(2, int(face_r * 0.18))
    tick_w = max(2, int(face_r * 0.10))
    # 12
    draw.rectangle(
        [cx - tick_w // 2, cy - face_r + tick_w, cx + tick_w // 2, cy - face_r + tick_len + tick_w],
        fill=TICK,
    )
    # 6
    draw.rectangle(
        [cx - tick_w // 2, cy + face_r - tick_len - tick_w, cx + tick_w // 2, cy + face_r - tick_w],
        fill=TICK,
    )
    # 3
    draw.rectangle(
        [cx + face_r - tick_len - tick_w, cy - tick_w // 2, cx + face_r - tick_w, cy + tick_w // 2],
        fill=TICK,
    )
    # 9
    draw.rectangle(
        [cx - face_r + tick_w, cy - tick_w // 2, cx - face_r + tick_len + tick_w, cy + tick_w // 2],
        fill=TICK,
    )

    # 針 (12時 と 2時 方向)
    hand_w = max(3, int(face_r * 0.10))
    # 短針: 12時方向 (上)
    draw.rectangle(
        [cx - hand_w // 2, cy - int(face_r * 0.55), cx + hand_w // 2, cy + hand_w // 2],
        fill=HAND,
    )
    # 長針: 2時方向 (斜め右上) - 線で描画
    end_x = cx + int(face_r * 0.6 * 0.5)  # cos(60°)
    end_y = cy - int(face_r * 0.6 * 0.866)  # sin(60°)
    draw.line([(cx, cy), (end_x, end_y)], fill=HAND, width=hand_w)

    # 中心の小さな円
    pin_r = max(2, int(face_r * 0.10))
    draw.ellipse([cx - pin_r, cy - pin_r, cx + pin_r, cy + pin_r], fill=ACCENT)

    # 縮小
    return img.resize((size, size), Image.LANCZOS)


if __name__ == "__main__":
    for size in [16, 48, 128]:
        out = draw_icon(size)
        out.save(f"icons/icon{size}.png")
        print(f"wrote icons/icon{size}.png")
