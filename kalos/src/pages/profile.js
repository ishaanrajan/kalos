import { supabase } from '../supabaseClient';
import { useEffect, useState } from 'react';

export default function Profile() {
  const [user, setUser] = useState(null);

  useEffect(() => {
    async function fetchUser() {
      const { data: { user } } = await supabase.auth.getUser();
      setUser(user);
    }
    fetchUser();
  }, []);

  async function handleLogout() {
    await supabase.auth.signOut();
  }

  return (
    <div>
      <h1>👤 Profile</h1>
      {user && (
        <>
          <p>Email: {user.email}</p>
          <button onClick={handleLogout}>Log Out</button>
        </>
      )}
    </div>
  );
}
