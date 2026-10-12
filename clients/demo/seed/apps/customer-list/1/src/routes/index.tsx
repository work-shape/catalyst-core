import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import {
  actions,
  AppCallError,
  Banner,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  getContext,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "@work-shape/catalyst-app-kit";
import { readCustomerPage, type CustomerPage } from "../customers";
import { textsFor, type Texts } from "../texts";

/** How many customers one load asks for. */
const ROWS = 12;

type Loaded =
  | { state: "loading" }
  | { state: "rows"; page: CustomerPage }
  | { state: "forbidden"; right: string }
  | { state: "failed" };

/** One call of the named action. It runs with the rights of whoever looks at the tile. */
async function loadCustomers(): Promise<Loaded> {
  try {
    const answer = await actions.call("list-customers", { limit: ROWS });
    const page = readCustomerPage(answer.result);
    return page ? { state: "rows", page } : { state: "failed" };
  } catch (error) {
    return error instanceof AppCallError && error.code === "forbidden" && error.right
      ? { state: "forbidden", right: error.right }
      : { state: "failed" };
  }
}

function Rows({ page, texts }: { page: CustomerPage; texts: Texts }) {
  if (page.rows.length === 0) {
    return <p>{texts.empty}</p>;
  }
  return (
    <>
      <p>{texts.shown(page.rows.length, page.total)}</p>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{texts.name}</TableHead>
            <TableHead>{texts.segment}</TableHead>
            <TableHead>{texts.city}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {page.rows.map((customer) => (
            <TableRow key={customer.id}>
              <TableCell>{customer.name}</TableCell>
              <TableCell>{texts.segments[customer.segment]}</TableCell>
              <TableCell>{customer.city}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </>
  );
}

function Customers() {
  const [texts, setTexts] = useState<Texts>(() => textsFor("en"));
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(() => {
    setLoading(true);
    loadCustomers()
      .then(setLoaded)
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    getContext()
      .then((context) => setTexts(textsFor(context.locale)))
      .catch(() => undefined);
    refresh();
  }, [refresh]);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-4">
        <CardTitle>{texts.title}</CardTitle>
        <Button variant="outline" size="sm" loading={loading} onClick={refresh}>
          {texts.refresh}
        </Button>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {loaded.state === "rows" ? <Rows page={loaded.page} texts={texts} /> : null}
        {loaded.state === "forbidden" ? (
          <Banner tone="warning">{texts.forbidden(loaded.right)}</Banner>
        ) : null}
        {loaded.state === "failed" ? <Banner tone="danger">{texts.failed}</Banner> : null}
      </CardContent>
    </Card>
  );
}

export const Route = createFileRoute("/")({ component: Customers });
