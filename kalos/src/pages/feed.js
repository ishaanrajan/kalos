import { supabase } from '../supabaseClient';
import { useEffect, useState } from 'react';

export default function Feed() {
  const [posts, setPosts] = useState([]);

  useEffect(() => {
    async function fetchPosts() {
      const { data, error } = await supabase.from('posts').select('*').order('created_at', { ascending: false });
      if (error) console.error(error);
      else setPosts(data);
    }
    fetchPosts();
  }, []);

  return (
    <div>
      <h1>📸 Retrogram Feed</h1>
      {posts.length === 0 ? (
        <p>No posts yet!</p>
      ) : (
        posts.map(post => (
          <div key={post.id} style={{ marginBottom: '20px' }}>
            <img src={post.image_url} alt="Post" style={{ width: '300px', height: '300px', objectFit: 'cover' }} />
            <p>{post.caption}</p>
          </div>
        ))
      )}
    </div>
  );
}
