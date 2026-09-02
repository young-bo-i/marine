#!/usr/bin/env python3
"""Compile the frozen Scholay workbook into deterministic, style-only assets.

The compiler reads OOXML directly with the Python standard library. It never
opens the source workbook for writing and deliberately excludes WIKI evidence
text, video URLs, and any publication authority from the generated assets.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import posixpath
import re
import sys
from collections import Counter, defaultdict
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Iterable
from zipfile import BadZipFile, ZipFile
from xml.etree import ElementTree as ET


ASSET_VERSION = "scholay-comment-corpus-20260814.v1"
COMPILER_VERSION = "1.0.0"
SOURCE_FILE_NAME = "预制人-Scholay-WIKI-评论360条-20260814.xlsx"
OUTPUT_FILES = (
    "personas.json",
    "comment-exemplars.json",
    "generation-policy.json",
    "manifest.json",
)

MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
OFFICE_REL_NS = (
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
)
PACKAGE_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
NS = {"m": MAIN_NS, "r": OFFICE_REL_NS, "pr": PACKAGE_REL_NS}

BEHAVIOR_DIMENSIONS = (
    (
        "initiative",
        "主动性",
        "主动提出下一步、验证动作或可执行改进的倾向。",
    ),
    ("structure", "结构性", "按条件、步骤和依赖组织表达的倾向。"),
    ("warmth", "温暖度", "先承接内容价值和受众处境、再提出限定的倾向。"),
    ("questioning", "质疑方式", "指出论证缺口、边界和待核验前提的倾向。"),
    ("evidenceSeeking", "证据偏好", "要求出处、原文、数据和可复核链路的倾向。"),
    ("humor", "幽默", "使用轻度机锋或口语化缓冲的倾向，不授权攻击他人。"),
    ("riskSensitivity", "风险敏感", "主动识别未知、误用、合规或责任风险的倾向。"),
    ("expressionLength", "表达长度", "在允许字符范围内使用较短或较完整论证的倾向。"),
    ("languageDensity", "语言密度", "单位篇幅承载术语、条件和信息点的倾向。"),
)
BEHAVIOR_KEYS = tuple(item[0] for item in BEHAVIOR_DIMENSIONS)


class CorpusCompileError(RuntimeError):
    """Raised when the frozen workbook violates the compiler contract."""


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise CorpusCompileError(message)


def _sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _json_bytes(value: Any) -> bytes:
    return (
        json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    ).encode("utf-8")


def _resolve_part(base: str, target: str) -> str:
    if target.startswith("/"):
        return target.lstrip("/")
    return posixpath.normpath(posixpath.join(posixpath.dirname(base), target))


def _column_number(address: str) -> int:
    match = re.fullmatch(r"([A-Z]+)\d+", address)
    if not match:
        raise CorpusCompileError(f"Unsupported cell address: {address}")
    number = 0
    for character in match.group(1):
        number = number * 26 + ord(character) - ord("A") + 1
    return number


def _row_number(address: str) -> int:
    match = re.fullmatch(r"[A-Z]+(\d+)", address)
    if not match:
        raise CorpusCompileError(f"Unsupported cell address: {address}")
    return int(match.group(1))


class OOXMLWorkbook:
    """Small read-only OOXML reader for the workbook features used here."""

    def __init__(self, path: Path):
        self.path = path
        self._archive = ZipFile(path, "r")
        self._shared_strings = self._load_shared_strings()
        self._sheet_parts = self._load_sheet_parts()
        self._sheet_cache: dict[str, dict[int, dict[int, str | None]]] = {}

    def close(self) -> None:
        self._archive.close()

    def __enter__(self) -> "OOXMLWorkbook":
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    def _load_shared_strings(self) -> list[str]:
        part = "xl/sharedStrings.xml"
        if part not in self._archive.namelist():
            return []
        root = ET.fromstring(self._archive.read(part))
        return [
            "".join(node.text or "" for node in item.findall(".//m:t", NS))
            for item in root.findall("m:si", NS)
        ]

    def _load_sheet_parts(self) -> dict[str, str]:
        workbook_part = "xl/workbook.xml"
        workbook = ET.fromstring(self._archive.read(workbook_part))
        relationships = ET.fromstring(
            self._archive.read("xl/_rels/workbook.xml.rels")
        )
        targets = {
            item.get("Id"): item.get("Target")
            for item in relationships.findall("pr:Relationship", NS)
        }
        parts: dict[str, str] = {}
        for sheet in workbook.findall("m:sheets/m:sheet", NS):
            relationship_id = sheet.get(f"{{{OFFICE_REL_NS}}}id")
            target = targets.get(relationship_id)
            name = sheet.get("name")
            _require(bool(name and target), "Workbook contains an unresolved sheet")
            parts[str(name)] = _resolve_part(workbook_part, str(target))
        return parts

    def _cell_value(self, cell: ET.Element) -> str | None:
        cell_type = cell.get("t")
        if cell_type == "inlineStr":
            return "".join(
                node.text or "" for node in cell.findall(".//m:t", NS)
            )
        value = cell.find("m:v", NS)
        if value is None:
            return None
        raw = value.text or ""
        if cell_type == "s":
            return self._shared_strings[int(raw)]
        if cell_type == "b":
            return "true" if raw == "1" else "false"
        return raw

    def rows(self, sheet_name: str) -> dict[int, dict[int, str | None]]:
        cached = self._sheet_cache.get(sheet_name)
        if cached is not None:
            return cached
        part = self._sheet_parts.get(sheet_name)
        _require(part is not None, f"Missing required sheet: {sheet_name}")
        root = ET.fromstring(self._archive.read(str(part)))
        rows: dict[int, dict[int, str | None]] = defaultdict(dict)
        for cell in root.findall(".//m:sheetData/m:row/m:c", NS):
            address = cell.get("r")
            _require(address is not None, f"Cell without address in {sheet_name}")
            rows[_row_number(str(address))][_column_number(str(address))] = (
                self._cell_value(cell)
            )
        result = dict(rows)
        self._sheet_cache[sheet_name] = result
        return result

    def records(self, sheet_name: str, header_row: int = 4) -> list[dict[str, Any]]:
        rows = self.rows(sheet_name)
        headers = {
            column: str(value)
            for column, value in rows.get(header_row, {}).items()
            if value not in (None, "")
        }
        _require(bool(headers), f"Missing headers in {sheet_name}!{header_row}")
        records: list[dict[str, Any]] = []
        for row_number in sorted(row for row in rows if row > header_row):
            record = {header: rows[row_number].get(column) for column, header in headers.items()}
            if any(value not in (None, "") for value in record.values()):
                record["_row"] = row_number
                records.append(record)
        return records


def _number(value: Any) -> int | float:
    number = float(str(value))
    return int(number) if number.is_integer() else number


def _yes(value: Any) -> bool:
    return str(value).strip() == "是"


def _split_list(value: Any) -> list[str]:
    return [
        item.strip()
        for item in re.split(r"[；;]", str(value or ""))
        if item.strip()
    ]


def _split_codes(value: Any) -> list[str]:
    return sorted(set(_split_list(value)))


def _excel_serial_to_iso(value: Any) -> str | None:
    if value in (None, ""):
        return None
    moment = datetime(1899, 12, 30) + timedelta(days=float(str(value)))
    return moment.replace(microsecond=0).isoformat() + "Z"


def _sentence_count(text: str) -> int:
    parts = [part for part in re.split(r"[。！？!?；;]", text) if part.strip()]
    return max(1, len(parts))


def _keyword_tokens(*values: Any) -> list[str]:
    tokens: list[str] = []
    seen: set[str] = set()
    for value in values:
        for raw in re.split(r"[\s,，、；;|/]+", str(value or "")):
            token = raw.strip(".。:：()（）[]【】\"'“”‘’")
            if not token:
                continue
            normalized = token.casefold()
            if normalized in seen:
                continue
            seen.add(normalized)
            tokens.append(token)
    return tokens[:18]


def _source_reference(
    source_path: Path, version_records: Iterable[dict[str, Any]]
) -> dict[str, Any]:
    version_map = {
        str(record.get("项目")): record.get("值") for record in version_records
    }
    return {
        "fileName": source_path.name,
        "runId": version_map.get("Run ID"),
        "sha256": _sha256_file(source_path),
        "workbookAuditAt": _excel_serial_to_iso(version_map.get("工作簿审计时间")),
    }


def _compile_personas(
    people: list[dict[str, Any]],
    parameters: list[dict[str, Any]],
    source: dict[str, Any],
) -> dict[str, Any]:
    effective_by_person: dict[str, dict[str, int | float]] = defaultdict(dict)
    for parameter in parameters:
        if parameter.get("框架") != "有效行为画像":
            continue
        person_id = str(parameter.get("PersonID"))
        key = str(parameter.get("指标代码"))
        effective_by_person[person_id][key] = _number(parameter.get("数值"))

    cards: list[dict[str, Any]] = []
    for person in people:
        person_id = str(person.get("PersonID"))
        effective = effective_by_person.get(person_id, {})
        _require(
            set(effective) == set(BEHAVIOR_KEYS),
            f"{person_id} does not have exactly nine effective behavior dimensions",
        )
        cards.append(
            {
                "alias": person.get("别名"),
                "approved": _yes(person.get("已批准")),
                "boundaries": _split_list(person.get("边界")),
                "capabilities": _split_list(person.get("能力")),
                "discipline": person.get("学科"),
                "effectiveBehavior": {
                    key: effective[key] for key in BEHAVIOR_KEYS
                },
                "fictional": _yes(person.get("虚构")),
                "id": person_id,
                "motivation": person.get("动机"),
                "runtimeCatalogVersion": person.get("运行目录版本"),
                "sourcePersonaVersion": person.get("源人格版本"),
                "stage": person.get("阶段"),
                "status": person.get("状态"),
            }
        )

    _require(len(cards) == 12, f"Expected 12 personas, found {len(cards)}")
    _require(
        [card["id"] for card in cards] == [f"P{number:02d}" for number in range(1, 13)],
        "Persona IDs are not the frozen P01-P12 sequence",
    )
    _require(all(card["fictional"] for card in cards), "Every persona must be fictional")
    _require(all(card["approved"] for card in cards), "Every persona must be approved")

    return {
        "assetVersion": ASSET_VERSION,
        "behaviorDimensions": [
            {
                "description": description,
                "key": key,
                "label": label,
                "scale": {"max": 100, "min": 0},
            }
            for key, label, description in BEHAVIOR_DIMENSIONS
        ],
        "personas": cards,
        "schemaVersion": "scholay.personas.v1",
        "source": source,
    }


def _compile_exemplars(
    comments: list[dict[str, Any]],
    videos: list[dict[str, Any]],
    attempts: list[dict[str, Any]],
    source: dict[str, Any],
) -> dict[str, Any]:
    videos_by_case = {str(video.get("CaseID")): video for video in videos}
    generation_attempts: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for attempt in attempts:
        if attempt.get("阶段") == "marine-generate":
            generation_attempts[str(attempt.get("JobID"))].append(attempt)

    exemplars: list[dict[str, Any]] = []
    indexes: dict[str, dict[str, list[str]]] = {
        "byBrandMode": defaultdict(list),
        "byPersona": defaultdict(list),
        "byPersonaTopicBrandMode": defaultdict(list),
        "byPlatform": defaultdict(list),
        "byTopic": defaultdict(list),
    }

    for ordinal, comment in enumerate(comments, start=1):
        row = int(comment["_row"])
        job_id = str(comment.get("JobID"))
        case_id = str(comment.get("CaseID"))
        video = videos_by_case.get(case_id)
        _require(video is not None, f"Missing video row for {case_id}")
        person_id = str(comment.get("PersonID"))
        topic = str(comment.get("主题"))
        platform = str(comment.get("平台"))
        action = str(comment.get("原始品牌动作(rawBrandAction)"))
        brand_mode = str(comment.get("有效品牌模式(effectiveBrandMode)"))
        text = str(comment.get("评论正文") or "")
        history = sorted(generation_attempts.get(job_id, []), key=lambda item: int(item["_row"]))
        issue_codes = sorted(
            {
                code
                for attempt in history
                for code in _split_codes(attempt.get("问题代码"))
            }
        )
        transport_errors = sorted(
            {
                str(attempt.get("错误代码"))
                for attempt in history
                if attempt.get("错误代码") not in (None, "")
            }
        )
        exemplar_id = f"scholay-style-{ordinal:04d}"
        exemplar = {
            "action": action,
            "angle": comment.get("表达角度"),
            "brandMentioned": _yes(comment.get("实际品牌提及(actualBrandMention)")),
            "brandMode": brand_mode,
            "charCount": int(_number(comment.get("字符数"))),
            "contextQuality": comment.get("上下文质量"),
            "feedback": {
                "finalStatus": comment.get("状态"),
                "generationAttempts": len(history),
                "hadRetry": len(history) > 1,
                "humanReviewed": False,
                "issueCodes": issue_codes,
                "machineAccepted": comment.get("计划实际一致") == "PASS",
                "transportErrors": transport_errors,
            },
            "id": exemplar_id,
            "keywords": _keyword_tokens(
                topic,
                comment.get("表达角度"),
                video.get("知识查询"),
            ),
            "personaId": person_id,
            "platform": platform,
            "relevance": comment.get("相关度"),
            "safety": {
                "abstained": _yes(comment.get("ABSTAIN")),
                "draftOnly": _yes(comment.get("仅草稿")),
                "noPublish": _yes(comment.get("禁止发布")),
            },
            "sentenceCount": _sentence_count(text),
            "source": {
                "caseId": case_id,
                "jobId": job_id,
                "row": row,
                "sheet": "评论总表",
                "textCell": f"P{row}",
            },
            "text": text,
            "topic": topic,
        }
        exemplars.append(exemplar)
        indexes["byBrandMode"][brand_mode].append(exemplar_id)
        indexes["byPersona"][person_id].append(exemplar_id)
        indexes["byPersonaTopicBrandMode"][
            f"{person_id}|{topic}|{brand_mode}"
        ].append(exemplar_id)
        indexes["byPlatform"][platform].append(exemplar_id)
        indexes["byTopic"][topic].append(exemplar_id)

    _require(len(exemplars) == 360, f"Expected 360 exemplars, found {len(exemplars)}")
    _require(
        Counter(item["brandMode"] for item in exemplars)
        == Counter({"required": 252, "evidence_only": 108}),
        "Brand mode distribution changed",
    )
    _require(
        all(item["feedback"]["machineAccepted"] for item in exemplars),
        "Every exported exemplar must be a final machine-accepted result",
    )
    _require(
        all(item["safety"]["draftOnly"] and item["safety"]["noPublish"] for item in exemplars),
        "Style exemplars cannot carry publication authority",
    )

    return {
        "assetVersion": ASSET_VERSION,
        "exemplars": exemplars,
        "indexes": {
            name: dict(values) for name, values in indexes.items()
        },
        "schemaVersion": "scholay.comment-exemplars.v1",
        "source": source,
        "usage": {
            "allowedSignals": [
                "persona focus",
                "tone",
                "argument structure",
                "length calibration",
            ],
            "notAuthorityFor": [
                "product facts",
                "WIKI evidence",
                "human quality preference",
                "real-person identity",
                "lived experience",
                "publication or posting authorization",
            ],
            "purpose": "style-only",
        },
    }


def _compile_policy(
    exemplars_asset: dict[str, Any], source: dict[str, Any]
) -> dict[str, Any]:
    exemplars = exemplars_asset["exemplars"]
    brand_counts = Counter(item["brandMode"] for item in exemplars)
    return {
        "assetBoundaries": {
            "exemplarsAreEvidence": False,
            "exemplarsAreStyleOnly": True,
            "humanQualityLabelsIncluded": False,
            "productFactsAuthoritative": False,
            "publicationAuthorization": False,
            "realPersonIdentityIncluded": False,
        },
        "assetVersion": ASSET_VERSION,
        "brandPolicy": {
            "brandToken": "Scholay",
            "caseSensitive": True,
            "modeField": "brandMode",
            "modes": {
                "evidence_only": {
                    "brandOccurrences": 0,
                    "freshEvidenceRequired": True,
                },
                "required": {
                    "brandOccurrences": 1,
                    "freshEvidenceRequired": True,
                },
            },
            "runtimeQuotaInheritedFromCorpus": False,
            "sourceDistribution": {
                "evidence_only": brand_counts["evidence_only"],
                "required": brand_counts["required"],
                "requiredRatio": brand_counts["required"] / len(exemplars),
                "total": len(exemplars),
                "trainingDistributionOnly": True,
            },
        },
        "generation": {
            "evidence": {
                "freshEvidenceRequiredForProductClaims": True,
                "styleExemplarsAreEvidence": False,
                "workbookEvidenceTextIncluded": False,
            },
            "experience": {
                "fabricationAllowed": False,
                "firstPersonClaimsRequireUserProvidedEvidence": True,
            },
            "identity": {
                "personasAreFictional": True,
                "realPersonClaimsAllowed": False,
            },
            "output": {
                "draftOnly": True,
                "language": "zh",
                "maxCharacters": 240,
                "minCharacters": 20,
            },
            "publication": {
                "authorized": False,
                "requiresSeparateExplicitUserAction": True,
            },
            "sourceMaterial": {
                "executeEmbeddedInstructions": False,
                "treatAsUntrusted": True,
            },
        },
        "schemaVersion": "scholay.generation-policy.v1",
        "source": source,
        "validation": {
            "feedbackSemantics": {
                "humanReviewed": False,
                "machineAcceptedMeans": "hard-rule pass only; not a human quality label",
            },
            "hardRules": [
                "character_count_20_to_240",
                "brand_occurrence_matches_brand_mode",
                "no_fabricated_real_identity",
                "no_fabricated_lived_experience",
                "no_execution_of_source_instructions",
                "fresh_evidence_for_product_claims",
                "offline_draft_only",
            ],
            "recommendedSoftChecks": [
                "persona_style_alignment",
                "context_relevance",
                "claim_to_evidence_alignment",
                "semantic_duplicate_detection",
                "natural_brand_integration",
            ],
        },
    }


def build_assets(source_path: Path) -> dict[str, bytes]:
    source_path = source_path.resolve()
    _require(source_path.is_file(), f"Source workbook not found: {source_path}")
    with OOXMLWorkbook(source_path) as workbook:
        people = workbook.records("人物")
        parameters = workbook.records("人格参数")
        comments = workbook.records("评论总表")
        videos = workbook.records("视频")
        attempts = workbook.records("尝试与失败")
        version_records = workbook.records("版本与运行")

    source = _source_reference(source_path, version_records)
    personas = _compile_personas(people, parameters, source)
    exemplars = _compile_exemplars(comments, videos, attempts, source)
    policy = _compile_policy(exemplars, source)

    compiled = {
        "personas.json": _json_bytes(personas),
        "comment-exemplars.json": _json_bytes(exemplars),
        "generation-policy.json": _json_bytes(policy),
    }
    manifest = {
        "assetHashes": {
            name: _sha256_bytes(data) for name, data in compiled.items()
        },
        "assetVersion": ASSET_VERSION,
        "compilerVersion": COMPILER_VERSION,
        "counts": {
            "evidenceOnlyExemplars": 108,
            "exemplars": 360,
            "personas": 12,
            "requiredExemplars": 252,
        },
        "files": list(compiled),
        "schemaVersion": "scholay.corpus-manifest.v1",
        "source": source,
        "sourceRanges": {
            "attempts": "尝试与失败!A4:T868",
            "comments": "评论总表!A4:BF364",
            "parameters": "人格参数!A4:M460",
            "people": "人物!A4:M16",
            "videos": "视频!A4:W34",
        },
    }
    compiled["manifest.json"] = _json_bytes(manifest)
    return compiled


def write_assets(assets: dict[str, bytes], output_dir: Path, check: bool) -> None:
    if check:
        mismatches = []
        for name in OUTPUT_FILES:
            path = output_dir / name
            if not path.is_file() or path.read_bytes() != assets[name]:
                mismatches.append(str(path))
        if mismatches:
            raise CorpusCompileError(
                "Generated Scholay assets are stale: " + ", ".join(mismatches)
            )
        return

    output_dir.mkdir(parents=True, exist_ok=True)
    for name in OUTPUT_FILES:
        (output_dir / name).write_bytes(assets[name])


def default_source_path() -> Path:
    return Path(__file__).resolve().parents[2] / SOURCE_FILE_NAME


def default_output_dir() -> Path:
    return (
        Path(__file__).resolve().parents[1]
        / "marine-extension"
        / "skills"
        / "scholay"
        / "generated"
    )


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=default_source_path())
    parser.add_argument("--output-dir", type=Path, default=default_output_dir())
    parser.add_argument(
        "--check",
        action="store_true",
        help="Fail when committed assets differ; do not write files.",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        assets = build_assets(args.source)
        write_assets(assets, args.output_dir, args.check)
    except (BadZipFile, CorpusCompileError, KeyError, ValueError) as error:
        print(f"Scholay corpus compile failed: {error}", file=sys.stderr)
        return 1
    action = "verified" if args.check else "generated"
    print(f"{action} {len(assets)} Scholay assets in {args.output_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
