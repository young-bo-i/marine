#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
import re
import sys
import unittest
from collections import Counter
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "scripts"))

from compile_scholay_corpus import (  # noqa: E402
    BEHAVIOR_KEYS,
    OUTPUT_FILES,
    build_assets,
    default_output_dir,
    default_source_path,
)


class ScholayCorpusCompilerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.output_dir = default_output_dir()
        cls.assets = {
            name: json.loads((cls.output_dir / name).read_text(encoding="utf-8"))
            for name in OUTPUT_FILES
        }
        cls.personas = cls.assets["personas.json"]
        cls.exemplars = cls.assets["comment-exemplars.json"]
        cls.policy = cls.assets["generation-policy.json"]
        cls.manifest = cls.assets["manifest.json"]

    def test_compiler_output_is_reproducible(self) -> None:
        source = default_source_path()
        if not source.is_file():
            self.skipTest(f"Source workbook is not available: {source}")
        rebuilt = build_assets(source)
        for name in OUTPUT_FILES:
            self.assertEqual((self.output_dir / name).read_bytes(), rebuilt[name], name)

    def test_source_hash_and_asset_hashes(self) -> None:
        source = default_source_path()
        if source.is_file():
            self.assertEqual(
                hashlib.sha256(source.read_bytes()).hexdigest(),
                self.manifest["source"]["sha256"],
            )
        for name, expected in self.manifest["assetHashes"].items():
            self.assertEqual(
                hashlib.sha256((self.output_dir / name).read_bytes()).hexdigest(),
                expected,
                name,
            )

    def test_persona_cards_only_use_effective_behavior_profile(self) -> None:
        cards = self.personas["personas"]
        self.assertEqual(len(cards), 12)
        self.assertEqual([card["id"] for card in cards], [f"P{n:02d}" for n in range(1, 13)])
        dimensions = self.personas["behaviorDimensions"]
        self.assertEqual([item["key"] for item in dimensions], list(BEHAVIOR_KEYS))
        self.assertTrue(all(item["label"] and item["description"] for item in dimensions))
        for card in cards:
            self.assertTrue(card["fictional"])
            self.assertTrue(card["approved"])
            self.assertEqual(set(card["effectiveBehavior"]), set(BEHAVIOR_KEYS))
            self.assertTrue(all(0 <= value <= 100 for value in card["effectiveBehavior"].values()))
            self.assertNotIn("bigFive", card)
            self.assertNotIn("mbti", card)
            self.assertNotIn("sixteenPf", card)
            joined_boundaries = "".join(card["boundaries"])
            self.assertIn("不得声称真实就读院校", joined_boundaries)
            self.assertIn("不得虚构亲身使用", joined_boundaries)

    def test_exemplar_counts_and_indexes(self) -> None:
        exemplars = self.exemplars["exemplars"]
        self.assertEqual(len(exemplars), 360)
        self.assertEqual(
            Counter(item["brandMode"] for item in exemplars),
            Counter({"required": 252, "evidence_only": 108}),
        )
        self.assertEqual(
            Counter(item["action"] for item in exemplars),
            Counter({"recommended": 264, "optional": 96}),
        )
        self.assertEqual(Counter(item["platform"] for item in exemplars), Counter({"bilibili": 360}))
        self.assertEqual(
            Counter(item["topic"] for item in exemplars),
            Counter(
                {
                    "discovery": 60,
                    "reading_extraction": 60,
                    "research_life": 60,
                    "research_methods": 60,
                    "visualization_presentation": 60,
                    "writing_revision": 60,
                }
            ),
        )
        persona_counts = Counter(item["personaId"] for item in exemplars)
        self.assertEqual(persona_counts, Counter({f"P{n:02d}": 30 for n in range(1, 13)}))
        for person_id in persona_counts:
            person_rows = [item for item in exemplars if item["personaId"] == person_id]
            self.assertEqual(Counter(item["brandMode"] for item in person_rows), Counter({"required": 21, "evidence_only": 9}))

        indexes = self.exemplars["indexes"]
        self.assertEqual(sum(len(ids) for ids in indexes["byPersona"].values()), 360)
        self.assertEqual(sum(len(ids) for ids in indexes["byTopic"].values()), 360)
        self.assertEqual(sum(len(ids) for ids in indexes["byBrandMode"].values()), 360)
        self.assertEqual(
            sum(len(ids) for ids in indexes["byPersonaTopicBrandMode"].values()),
            360,
        )

    def test_feedback_is_machine_rule_feedback_not_human_preference(self) -> None:
        exemplars = self.exemplars["exemplars"]
        self.assertTrue(all(item["feedback"]["machineAccepted"] for item in exemplars))
        self.assertTrue(all(not item["feedback"]["humanReviewed"] for item in exemplars))
        self.assertEqual(sum(item["feedback"]["hadRetry"] for item in exemplars), 143)
        self.assertEqual(
            sum("BRAND_MENTION_MISSING" in item["feedback"]["issueCodes"] for item in exemplars),
            143,
        )
        self.assertEqual(
            sum("ROUTED_CAPABILITY_MISSING" in item["feedback"]["issueCodes"] for item in exemplars),
            143,
        )
        self.assertEqual(
            sum("HTTP_502" in item["feedback"]["transportErrors"] for item in exemplars),
            1,
        )
        self.assertFalse(self.policy["assetBoundaries"]["humanQualityLabelsIncluded"])

    def test_style_only_assets_do_not_grant_identity_or_publication_authority(self) -> None:
        self.assertEqual(self.exemplars["usage"]["purpose"], "style-only")
        self.assertTrue(self.policy["assetBoundaries"]["exemplarsAreStyleOnly"])
        self.assertFalse(self.policy["assetBoundaries"]["productFactsAuthoritative"])
        self.assertFalse(self.policy["assetBoundaries"]["publicationAuthorization"])
        self.assertFalse(self.policy["generation"]["identity"]["realPersonClaimsAllowed"])
        self.assertFalse(self.policy["generation"]["experience"]["fabricationAllowed"])
        self.assertFalse(self.policy["generation"]["publication"]["authorized"])

        excluded_source_fields = {"videoTitle", "videoUrl", "citationIds", "evidenceText"}
        risky_experience = re.compile(
            r"(?:我|本人)(?:用过|试过|购买过|买了|投稿过|投稿到|被录用|就读于|任职于)|"
            r"我们(?:学校|实验室|公司)|亲测"
        )
        for exemplar in self.exemplars["exemplars"]:
            self.assertTrue(exemplar["safety"]["draftOnly"])
            self.assertTrue(exemplar["safety"]["noPublish"])
            self.assertFalse(exemplar["safety"]["abstained"])
            self.assertFalse(excluded_source_fields & set(exemplar["source"]))
            self.assertIsNone(risky_experience.search(exemplar["text"]), exemplar["id"])

    def test_brand_modes_are_explicit_and_corpus_ratio_is_not_runtime_policy(self) -> None:
        brand_policy = self.policy["brandPolicy"]
        self.assertEqual(brand_policy["modes"]["required"]["brandOccurrences"], 1)
        self.assertEqual(brand_policy["modes"]["evidence_only"]["brandOccurrences"], 0)
        self.assertEqual(brand_policy["sourceDistribution"]["required"], 252)
        self.assertEqual(brand_policy["sourceDistribution"]["evidence_only"], 108)
        self.assertTrue(brand_policy["sourceDistribution"]["trainingDistributionOnly"])
        self.assertFalse(brand_policy["runtimeQuotaInheritedFromCorpus"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
