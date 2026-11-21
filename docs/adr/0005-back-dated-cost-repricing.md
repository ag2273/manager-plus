# Back-dated entries reprice later issues, one adjustment per day

Cost is one weighted average per item across warehouses. An issue (a till sale, a sales invoice,
a write-off, a count loss) takes the average at the moment it is posted. When a document moves
an item on a date earlier than movements already recorded (a purchase entered late, or a sale
dated in the past), the `Business` facade reprices that item after the command, inside the same
transaction: it walks the item's movements in date order, recomputes each later issue at the
average as it stood on its own date, updates the movement and the document's line cost, and posts
the difference as one `cost_adjustment` entry per date (Cost of goods sold or Stock loss against
Stock). The Stock account therefore always equals the sum of movement values.

Incoming movements keep their own value: purchases, opening stock, import shipment costs, count
gains, transfers (which carry no value), and returns, which come back at the cost their sale had
when they were posted. A return of a sale that was later repriced is not revalued; the gap is
small and stays in Stock until that stock is sold. An adjustment cannot land in a locked period,
so a back-dated document that would change a locked month's cost is refused with `period_locked`.
