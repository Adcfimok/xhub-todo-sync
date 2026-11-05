from PIL import Image, ImageDraw
import os

SPECS = [("mipmap-mdpi",48),("mipmap-hdpi",72),("mipmap-xhdpi",96),("mipmap-xxhdpi",144),("mipmap-xxxhdpi",192)]

def lerp(a,b,t): return tuple(int(a[i]+(b[i]-a[i])*t) for i in range(3))

def make(size):
    S = size*4
    img = Image.new("RGBA",(S,S),(0,0,0,0))
    # 圆角方块渐变
    grad = Image.new("RGBA",(S,S))
    gd = ImageDraw.Draw(grad)
    c1,c2 = (109,109,255),(74,74,216)
    for y in range(S):
        t = y/(S-1)
        gd.line([(0,y),(S,y)], fill=lerp(c1,c2,t)+(255,))
    mask = Image.new("L",(S,S),0)
    md = ImageDraw.Draw(mask)
    md.rounded_rectangle([0,0,S-1,S-1], radius=int(S*0.22), fill=255)
    img.paste(grad,(0,0),mask)

    d = ImageDraw.Draw(img)
    W = (255,255,255,255)
    r = S*0.045
    def line(x1,y1,x2,y2):
        d.rounded_rectangle([x1-r,y1-r,x2+r,y2+r], radius=r, fill=W)
    # 三行清单
    line(S*0.24,S*0.31,S*0.58,S*0.31)
    line(S*0.24,S*0.47,S*0.58,S*0.47)
    line(S*0.24,S*0.63,S*0.46,S*0.63)
    # 勾
    d.line([(S*0.56,S*0.64),(S*0.66,S*0.74),(S*0.82,S*0.44)], fill=W, width=int(S*0.075), joint="curve")
    return img.resize((size,size), Image.LANCZOS)

for folder,size in SPECS:
    os.makedirs(f"app/src/main/res/{folder}", exist_ok=True)
    make(size).save(f"app/src/main/res/{folder}/ic_launcher.png")
    print(folder,size)
