"""FreeJobAlert table parser regression test.

Pins parse_rows against the live row shape (verified 2026-09-16): tr classes
lattrbord latoclr/lateclr with td classes latcpb (post date) / latcr (board) /
latceb (post + count) / latcqb (qualification) / latcab (advt) / latclb (last
date) / latcmb (Get Details article link).
"""
from scrapers.freejobalert import FreeJobAlertScraper

LIVE_ROWS = """
<table><tr class="lattra"><th>x</th></tr>
<tr class="lattrbord latoclr"> <td class="latcpb">16/09/2026</td> <td class="latcr">Exim Bank</td> <td class="latceb"> Business Development Officer &#8211; 12 Posts </td> <td class="latcqb">Any Post Graduate, MBA/PGDM</td> <td class="latcab">&#8211;</td> <td class="latclb">15-10-2026</td> <td class="latcmb"><strong><a href="https://www.freejobalert.com/articles/exim-bank-3067808" aria-label="Exim Bank">Get Details</a></strong></td> </tr>
<tr class="lattrbord lateclr"> <td class="latcpb">09/09/2026</td> <td class="latcr">India Post</td> <td class="latceb"> Gramin Dak Sevak &#8211; 23757 Posts </td> <td class="latcqb">10TH</td> <td class="latcab">17-12/2026-GDS</td> <td class="latclb">21-09-2026</td> <td class="latcmb"><a href="https://www.freejobalert.com/articles/gds-1">Get Details</a></td> </tr>
</table>
"""  # noqa: E501


def test_live_row_shape_parses():
    rows = FreeJobAlertScraper.parse_rows(LIVE_ROWS)
    assert len(rows) == 2, rows
    first, second = rows
    assert first["board"] == "Exim Bank"
    assert "Business Development Officer" in first["post"]
    assert first["openings"] == "12"
    assert first["posted"] == "16/09/2026"
    assert first["url"] == "https://www.freejobalert.com/articles/exim-bank-3067808"
    assert second["board"] == "India Post"
    assert second["openings"] == "23757"
    assert second["qualification"] == "10TH"


def test_short_rows_skipped():
    assert FreeJobAlertScraper.parse_rows("<table><tr class=\"lattrbord latoclr\"><td>x</td></tr></table>") == []


if __name__ == "__main__":
    test_live_row_shape_parses()
    test_short_rows_skipped()
    print("freejobalert parser OK")
