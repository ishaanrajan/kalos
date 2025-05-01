import { useState } from 'react';
import { supabase } from '../supabaseClient';
import { useNavigate } from 'react-router-dom';

export default function Signup() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [username, setUsername] = useState('');
  const navigate = useNavigate();

  async function handleSignup() {
    const { data, error } = await supabase.auth.signUp({ email, password });
    if (error) {
        console.error(error);
        return;
    }

    const user = data.user;
    console.log("User:", user);
    const { error: insertError } = await supabase
        .from('users')
        .insert([
            {id: user.id, email: user.email, username: username, profile_pic: null}
        ]);
    if (insertError) {
        console.error(insertError);
    } else {
        navigate('/');
    }
  }

  return (
    <div>
      <h1>🆕 Signup</h1>
      <input
        type="username"
        placeholder="Username"
        value={username}
        onChange={(e) => setUsername(e.target.value)}
      />
      <input
        type="email"
        placeholder="Email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />
      <input
        type="password"
        placeholder="Password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      <button onClick={handleSignup}>Signup</button>
    </div>
  );
}
