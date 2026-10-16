"""열린데이터광장 전월세가 파일(연도별 zip/csv)을 API와 같은 영문 필드명의 dict로 읽는다."""
import csv
import io
import zipfile

# 파일(한글 헤더) -> API(영문 필드명)
COLUMNS = {
    "접수년도": "RCPT_YR", "자치구코드": "CGG_CD", "자치구명": "CGG_NM",
    "법정동코드": "STDG_CD", "법정동명": "STDG_NM", "지번구분코드": "LOTNO_SE",
    "지번구분": "LOTNO_SE_NM", "본번": "MNO", "부번": "SNO", "층": "FLR",
    "계약일": "CTRT_DAY", "전월세구분": "RENT_SE", "임대면적": "RENT_AREA",
    "보증금(만원)": "GRFE", "임대료(만원)": "RTFE", "건물명": "BLDG_NM",
    "건축년도": "ARCH_YR", "건물용도": "BLDG_USG", "계약기간": "CTRT_PRD",
    "신규계약구분": "NEW_UPDT_YN", "갱신청구권사용": "CTRT_UPDT_USE_YN",
    "종전보증금": "BFR_GRFE", "종전임대료": "BFR_RTFE",
}


def detect_encoding(path):
    with _open_text(path) as f:
        return f.encoding


def _open_text(path):
    """zip 안의 첫 csv 또는 csv 파일을 연다. 연도별로 UTF-8/CP949가 섞여 있어 앞부분으로 판별한다."""
    if str(path).lower().endswith(".zip"):
        z = zipfile.ZipFile(path)
        name = next(n for n in z.namelist() if n.lower().endswith(".csv"))
        opener = lambda: z.open(name)
    else:
        opener = lambda: open(path, "rb")
    with opener() as f:
        head = f.read(200_000)
    try:
        head.decode("utf-8")
        enc = "utf-8-sig"
    except UnicodeDecodeError as e:
        enc = "utf-8-sig" if e.start > len(head) - 4 else "cp949"
    return io.TextIOWrapper(opener(), encoding=enc, newline="")


def read_rows(path):
    with _open_text(path) as f:
        reader = csv.reader(f)
        header = next(reader)
        keys = [COLUMNS.get(h.strip(), h.strip()) for h in header]
        for values in reader:
            row = {k: v.strip() for k, v in zip(keys, values)}  # 건물명 앞뒤 탭 등 제거
            if row.get("CGG_CD") and row.get("STDG_CD"):
                yield row
