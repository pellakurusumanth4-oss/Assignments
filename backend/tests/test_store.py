"""Store behaviour: relative-date resolution, refund recording, abuse counting."""

from refund_agent.utils.store import RETURN_WINDOW_DAYS, store


def test_15_customers_loaded():
    assert len(store.all_customers()) == 15


def test_relative_dates_resolve():
    o = store.get_order("ord_1001")
    assert o["days_since_delivered"] == 10  # fixture says delivered 10 days ago
    o2 = store.get_order("ord_1002")
    assert o2["days_since_delivered"] == 45 > RETURN_WINDOW_DAYS


def test_customer_lookup_by_email_name_id():
    assert store.get_customer("alice.nguyen@example.com")["id"] == "cust_001"
    assert store.get_customer("Alice Nguyen")["id"] == "cust_001"
    assert store.get_customer("cust_001")["name"] == "Alice Nguyen"


def test_abuse_count():
    assert store.refunds_last_90_days("cust_004") == 4
    assert store.refunds_last_90_days("cust_001") == 0


def test_record_refund_flips_state():
    assert store.get_order("ord_1001")["already_refunded"] is False
    rec = store.record_refund("ord_1001", "cust_001", 129.99, "test")
    assert rec["amount"] == 129.99
    assert store.get_order("ord_1001")["already_refunded"] is True
    assert store.refund_for_order("ord_1001")["refund_id"] == rec["refund_id"]
