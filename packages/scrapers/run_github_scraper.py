import asyncio
import json
import logging
from pathlib import Path

from scrapers.github_jobs import GitHubJobsScraper


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)


async def main():
    print("\n🚀 Starting GitHub Jobs Scraper...\n")

    scraper = GitHubJobsScraper()

    try:
        jobs = await scraper.scrape()

        output_dir = Path("output")
        output_dir.mkdir(exist_ok=True)

        output_file = output_dir / "github_jobs.json"

        with open(output_file, "w", encoding="utf-8") as f:
            json.dump(jobs, f, indent=2, ensure_ascii=False, default=str)

        print(f"\n✅ Scraping completed")
        print(f"📦 Total jobs: {len(jobs)}")
        print(f"💾 Saved to: {output_file}")

    except Exception as e:
        logging.exception("❌ Scraper failed: %s", e)


if __name__ == "__main__":
    asyncio.run(main())