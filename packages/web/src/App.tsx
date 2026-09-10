import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuthStore } from '@/stores/auth';
import Layout from '@/components/Layout';
import Dashboard from '@/pages/Dashboard';
import Leads from '@/pages/Leads';
import LeadDetail from '@/pages/LeadDetail';
import Companies from '@/pages/Companies';
import Contacts from '@/pages/Contacts';
import Duplicates from '@/pages/Duplicates';
import Analytics from '@/pages/Analytics';
import Settings from '@/pages/Settings';
import Login from '@/pages/Login';
import Register from '@/pages/Register';
import { ErrorBoundary } from '@/components/ErrorBoundary';

function App() {
  const { isAuthenticated, user, init } = useAuthStore();

  React.useEffect(() => {
    init();
  }, []);

  if (!isAuthenticated) {
    return (
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
        <Route path="*" element={<Login />} />
      </Routes>
    );
  }

  const isAdmin = user?.role === 'admin';

  return (
    <ErrorBoundary>
      <Routes>
        <Route path="/" element={<Layout />}>
          <Route index element={<Navigate to="/dashboard" replace />} />
          <Route path="dashboard" element={<Dashboard />} />
          <Route path="leads" element={<Leads />} />
          <Route path="leads/:id" element={<LeadDetail />} />
          <Route path="companies" element={<Companies />} />
          <Route path="contacts" element={<Contacts />} />
          <Route path="duplicates" element={<Duplicates />} />
          <Route path="analytics" element={<Analytics />} />
          <Route path="settings" element={isAdmin ? <Settings /> : <Navigate to="/dashboard" replace />} />
        </Route>
        <Route path="/login" element={<Navigate to="/dashboard" replace />} />
        <Route path="/register" element={<Navigate to="/dashboard" replace />} />
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </ErrorBoundary>
  );
}

export default App;
