import { useState } from 'react';
import { supabase } from '../supabaseClient';
import { useNavigate } from 'react-router-dom';

export default function Upload() {
  const [image, setImage] = useState(null);
  const [caption, setCaption] = useState('');
  const navigate = useNavigate();

  async function handleUpload() {
    if (!image) return;

    const fileExt = image.name.split('.').pop();
    const fileName = `${Date.now()}.${fileExt}`;

    const { data, error: uploadError } = await supabase.storage
      .from('photos')
      .upload(fileName, image);

    if (uploadError) {
      console.error(uploadError);
      return;
    }

    const imageUrl = `${process.env.REACT_APP_SUPABASE_URL}/storage/v1/object/public/photos/${fileName}`;

    const { error: insertError } = await supabase.from('posts').insert([
      { image_url: imageUrl, caption }
    ]);

    if (insertError) {
      console.error(insertError);
    } else {
      navigate('/');
    }
  }

  return (
    <div>
      <h1>📤 Upload New Post</h1>
      <input type="file" onChange={(e) => setImage(e.target.files[0])} />
      <input
        type="text"
        placeholder="Write a caption..."
        value={caption}
        onChange={(e) => setCaption(e.target.value)}
      />
      <button onClick={handleUpload}>Upload</button>
    </div>
  );
}
