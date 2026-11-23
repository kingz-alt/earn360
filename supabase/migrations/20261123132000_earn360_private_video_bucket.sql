insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('earn360-video-library','earn360-video-library',false,262144000,array['video/mp4','video/webm'])
on conflict(id) do update set public=false,file_size_limit=262144000,allowed_mime_types=array['video/mp4','video/webm'];