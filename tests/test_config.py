"""설정 로드 테스트."""

from pathlib import Path

import yaml

from src.config import load_config


def test_partial_site_b_config(tmp_path):
  """name/adapter 없이 username만 있어도 로드되어야 함."""
  cfg_path = tmp_path / "settings.yaml"
  cfg_path.write_text(
    yaml.dump({
      "site_b": {
        "username": "testuser",
        "password": "testpass",
        "sport_pages": {
          "football": {"enabled": True, "nav_texts": ["축구"]},
        },
      },
    }),
    encoding="utf-8",
  )

  cfg = load_config(str(cfg_path))
  assert cfg.site_b.name == "PBC00"
  assert cfg.site_b.adapter == "pbc00"
  assert cfg.site_b.username == "testuser"
  assert cfg.site_b.password == "testpass"
  assert cfg.site_b.sport_pages["football"].nav_texts == ["축구"]
