import unittest

from tools import pool


class CasePlanTests(unittest.TestCase):
    def test_case_plan_keeps_pool_items_and_buyer_rotation(self):
        self.assertEqual(
            pool.case_plan(2, 2, first_buyer=2),
            [
                ("fight", "8.00", "Ceramic spoon rest", 2),
                ("fight", "10.50", "Small bud vase", 3),
                ("accept", "6.00", "Glaze recipe PDF, digital download", 1),
                ("accept", "7.50", "Pottery class video, digital download", 2),
            ],
        )

    def test_case_plan_rejects_invalid_counts_and_buyer(self):
        with self.assertRaises(ValueError):
            pool.case_plan(-1, 0)
        with self.assertRaises(ValueError):
            pool.case_plan(0, 0, first_buyer=4)


class ShipmentTests(unittest.TestCase):
    def test_fight_shipment_row_matches_pool_schema_and_is_delivered(self):
        sql = pool.shipment_sql("dd-p007", "ORDER-1", "CAPTURE-1", "1Z999AA112345678", "2026-10-23T12:00:00Z",
                                "2026-10-23T12:00:00Z")
        self.assertEqual(
            sql,
            "INSERT OR REPLACE INTO shipments (custom_id, order_id, capture_id, carrier, tracking_number, delivered_at, "
            "created_at) VALUES ('dd-p007', 'ORDER-1', 'CAPTURE-1', 'UPS', '1Z999AA112345678', "
            "'2026-10-23T12:00:00Z', '2026-10-23T12:00:00Z')",
        )

    def test_shipment_values_escape_quotes(self):
        sql = pool.shipment_sql("dd-p'o", "O", "C", "T", "now", "now")
        self.assertIn("'dd-p''o'", sql)


class WaitForDisputeTests(unittest.TestCase):
    def test_polls_until_waiting_seller_response_at_chargeback_stage(self):
        results = iter([
            (200, {"status": "UNDER_REVIEW", "dispute_life_cycle_stage": "CHARGEBACK"}),
            (200, {"status": "WAITING_FOR_SELLER_RESPONSE", "dispute_life_cycle_stage": "CHARGEBACK",
                  "links": [{"rel": "accept_claim"}, {"rel": "provide_evidence"}]}),
        ])
        sleeps = []
        found = pool.wait_for_dispute(lambda: next(results), attempts=3, interval=15, sleeper=sleeps.append)
        self.assertEqual(found["status"], "WAITING_FOR_SELLER_RESPONSE")
        self.assertEqual(sleeps, [15])

    def test_returns_none_when_dispute_never_reaches_target(self):
        sleeps = []
        found = pool.wait_for_dispute(lambda: (404, {}), attempts=3, interval=7, sleeper=sleeps.append)
        self.assertIsNone(found)
        self.assertEqual(sleeps, [7, 7])


if __name__ == "__main__":
    unittest.main()
