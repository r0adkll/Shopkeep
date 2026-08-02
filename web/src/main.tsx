import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  RouterProvider,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
} from "@tanstack/react-router";
import "./styles.css";
import { SetupPage } from "./pages/Setup";
import { LoginPage } from "./pages/Login";
import { DashboardPage } from "./pages/Dashboard";
import { ProductsPage } from "./pages/Products";
import { ListingsPage } from "./pages/Listings";
import { ConnectionsPage } from "./pages/Connections";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});

const rootRoute = createRootRoute({ component: () => <Outlet /> });

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: DashboardPage,
});

const setupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/setup",
  component: SetupPage,
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  component: LoginPage,
});

const productsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/products",
  component: ProductsPage,
});

const listingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/listings",
  component: ListingsPage,
});

const connectionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/connections",
  component: ConnectionsPage,
});

const router = createRouter({
  routeTree: rootRoute.addChildren([indexRoute, setupRoute, loginRoute, productsRoute, listingsRoute, connectionsRoute]),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
