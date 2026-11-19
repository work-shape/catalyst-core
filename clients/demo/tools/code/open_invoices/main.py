from catalyst_tools import tool


def euros(cents):
    """An amount in cents as euros, rounded to the cent."""
    return round(cents / 100, 2)


@tool
def open_invoices(ctx, customer_id: str, overdue_only: bool = False):
    """Sums the unpaid invoices of one customer of the sample business system.

    Call it when someone asks what a customer still owes or which of its invoices are
    overdue. Answers the open and overdue totals in EUR and the invoices, oldest due first.

    Args:
        customer_id: The customer's id, such as C-0001, from connection.sample-business.list_customers.
        overdue_only: Only the invoices whose due date has passed.
    """
    # The one Connection call: tool.yaml declares it, and the platform makes it as the caller.
    answer = ctx.connection("sample-business").call("get_customer", {"id": customer_id})
    # An MCP Connection answers { content, structuredContent }: the rows are in the second.
    found = answer["structuredContent"]
    customer = found["customer"]
    invoices = sorted(found["openInvoices"], key=lambda invoice: invoice["dueDate"])
    if overdue_only:
        invoices = [invoice for invoice in invoices if invoice["status"] == "overdue"]

    open_cents = sum(invoice["totalCents"] for invoice in invoices)
    overdue_cents = sum(
        invoice["totalCents"] for invoice in invoices if invoice["status"] == "overdue"
    )
    ctx.log(f"{customer['id']}: {len(invoices)} unpaid invoices")

    # The display: labelled values first, then a list of flat rows, which the generic data
    # view draws as a table.
    ctx.display.data(
        "sample_business.open_invoices",
        {
            "customer": customer["name"],
            "city": customer["city"],
            "unpaidInvoices": len(invoices),
            "openEur": euros(open_cents),
            "overdueEur": euros(overdue_cents),
            "oldestDue": invoices[0]["dueDate"] if invoices else None,
            "invoices": [
                {
                    "invoice": invoice["id"],
                    "dueDate": invoice["dueDate"],
                    "status": invoice["status"],
                    "amountEur": euros(invoice["totalCents"]),
                }
                for invoice in invoices
            ],
        },
        f"Open invoices: {customer['name']}",
    )

    # What the model reads: a short text, since the person sees the rows in the display.
    if not invoices:
        return f"{customer['name']} has no {'overdue' if overdue_only else 'unpaid'} invoices."
    return (
        f"{customer['name']} has {len(invoices)} unpaid invoices over {euros(open_cents):.2f} EUR, "
        f"{euros(overdue_cents):.2f} EUR of it overdue. The oldest was due on "
        f"{invoices[0]['dueDate']}. The invoices are shown beside the chat."
    )
