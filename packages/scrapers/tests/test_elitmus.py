"""eLitmus card parser regression test.

Pins parse_cards against the live card shape (verified 2026-09-16):
/jobs/<id>-<slug> link, <div class="false"> company, text-secondary meta lines
(Full Time / City, State, India / Fresher (batch) / ₹ salary). Expired-ribbon
cards must be skipped — dead postings create leads nobody can apply to.
"""
from scrapers.elitmus import ElitmusScraper

LIVE_CARD = """
<div class="mb-1 bg-white card-shadow border-bottom custom-card-height overflow-hidden"><div class="row pb-1 pt-3 px-3 mb-1"><div class="col-12 col-sm-10"><div class="px-2"><h6 class="fw-bold"><a class="alert-link text-dark" href="/jobs/33299-pratishthan-software-software-intern-bangalore?jobs_evaluation=2807">Software Intern</a></h6><div class="false">Pratishthan Software Ventures Pvt. Ltd.</div><span class="text-secondary">Full Time<br />Bangalore, Karnataka, India<br />Fresher (2026)<br /><p class="mb-0">₹ 6,25,000 | <span class='grey-text'>Internship Stipend is ₹ 40,000 per month</span></p></span></div></div></div></div><script src="x"></script>
"""  # noqa: E501

EXPIRED_CARD = """
<div class="mb-1 bg-white card-shadow border-bottom custom-card-height overflow-hidden"><div class="position-relative"><div class="expired-fork-ribbon black"><span class="expired-fork-ribbon-text">Expired</span></div></div><div class="row"><h6 class="fw-bold"><a href="/jobs/33235-mountblue-technologies-software-engineer-trainee">Software Engineer Trainee </a></h6><div class="false">MountBlue Technologies Pvt Ltd</div></div></div><script src="x"></script>
"""  # noqa: E501


def test_live_card_shape_parses():
    cards = ElitmusScraper.parse_cards(LIVE_CARD)
    assert len(cards) == 1, cards
    c = cards[0]
    assert c["title"] == "Software Intern"
    assert c["url"] == "https://www.elitmus.com/jobs/33299-pratishthan-software-software-intern-bangalore?jobs_evaluation=2807"
    assert c["company"] == "Pratishthan Software Ventures Pvt. Ltd."
    assert c["location"] == "Bangalore, Karnataka, India"
    assert "Fresher" in c["experience"]
    assert c["salary"] == "6,25,000"


def test_expired_cards_skipped():
    assert ElitmusScraper.parse_cards(EXPIRED_CARD) == []
    assert len(ElitmusScraper.parse_cards(LIVE_CARD + EXPIRED_CARD)) == 1


if __name__ == "__main__":
    test_live_card_shape_parses()
    test_expired_cards_skipped()
    print("elitmus parser OK")
