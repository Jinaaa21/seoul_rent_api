"""행정동 경계 GeoJSON을 서울 25개 자치구로 합쳐 public/data/seoul_gu.geojson 을 만든다.

사용법:
    python scripts/build_map.py <HangJeongDong_ver*.geojson>

입력은 vuski/admdongkor 형식(속성 sgg, sggnm, sidonm)의 행정동 경계다.
"""
import json
import sys
from pathlib import Path

import geopandas as gpd

OUT = Path(__file__).resolve().parent.parent / "public" / "data" / "seoul_gu.geojson"
TOLERANCE_M = 40  # 단순화 허용 오차(미터). 화면 폭 기준으로 티가 나지 않을 정도


def main(path):
    gdf = gpd.read_file(path)
    seoul = gdf[gdf["sidonm"] == "서울특별시"]
    gu = seoul.dissolve(by=["sgg", "sggnm"], as_index=False)[["sgg", "sggnm", "geometry"]]
    # 미터 좌표계에서 단순화해야 위도에 따른 왜곡이 없다. 경계 공유는 dissolve 결과 그대로 유지된다.
    gu = gu.to_crs(5179)
    gu["geometry"] = gu.geometry.simplify(TOLERANCE_M, preserve_topology=True)
    gu = gu.to_crs(4326).rename(columns={"sgg": "code", "sggnm": "name"})

    features = []
    for _, r in gu.iterrows():
        geom = json.loads(gpd.GeoSeries([r.geometry]).to_json())["features"][0]["geometry"]
        features.append({"type": "Feature", "properties": {"code": r["code"], "name": r["name"]},
                         "geometry": _round(geom)})
    OUT.write_text(json.dumps({"type": "FeatureCollection", "features": features},
                              ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"{len(features)}개 자치구 -> {OUT} ({OUT.stat().st_size / 1024:.0f}KB)")


def _round(geom, nd=5):
    def r(c):
        return [round(c[0], nd), round(c[1], nd)] if isinstance(c[0], (int, float)) else [r(x) for x in c]
    return {"type": geom["type"], "coordinates": r(geom["coordinates"])}


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
