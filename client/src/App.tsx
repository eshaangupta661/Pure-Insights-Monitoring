import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import AppShell from './components/AppShell';
import { useAuth } from './auth/AuthProvider';
import { AlertsProvider } from './realtime/AlertsProvider';
import LoginPage from './pages/LoginPage';
import OverviewPage from './pages/OverviewPage';
import ComingSoonPage from './pages/ComingSoonPage';

/** Everything behind sign-in. The socket exists only while a session does. */
function RequireAuth() {
  const { user } = useAuth();
  const location = useLocation();
  if (user === undefined) return null; // first /auth/me still in flight
  if (user === null) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return (
    <AlertsProvider>
      <AppShell />
    </AlertsProvider>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<RequireAuth />}>
        <Route index element={<OverviewPage />} />
        <Route path="reports/*" element={<ComingSoonPage title="Reports" />} />
        <Route path="alerts" element={<ComingSoonPage title="Alerts" />} />
        <Route path="costs" element={<ComingSoonPage title="Cost Attribution" />} />
        <Route path="data-quality" element={<ComingSoonPage title="Data Quality" />} />
        <Route path="*" element={<ComingSoonPage title="Page not found" notFound />} />
      </Route>
    </Routes>
  );
}
