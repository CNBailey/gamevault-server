import { useEffect, useState } from 'react';
import Header from './components/Header.jsx';
import Library from './pages/Library.jsx';
import Details from './pages/Details.jsx';
import Settings from './pages/Settings.jsx';
import { useScan } from './hooks.js';

function useHashRoute() {
  const read = () => window.location.hash.replace(/^#/, '') || '/';
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const on = () => { setRoute(read()); window.scrollTo(0, 0); };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

export default function App() {
  const route = useHashRoute();
  const scan = useScan();
  const [search, setSearch] = useState('');

  let page;
  let section = 'library';
  const game = /^\/game\/(\d+)/.exec(route);
  if (game) {
    page = <Details id={Number(game[1])} scanVersion={scan.version} />;
  } else if (route.startsWith('/settings')) {
    section = 'settings';
    page = <Settings scan={scan} />;
  } else {
    page = <Library search={search} scanVersion={scan.version} />;
  }

  return (
    <>
      <Header section={section} search={search} onSearch={setSearch} showSearch={section === 'library' && !game} scan={scan} />
      {page}
    </>
  );
}
