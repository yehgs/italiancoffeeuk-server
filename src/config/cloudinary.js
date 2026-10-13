import { v2 as cloudinary } from 'cloudinary';
import { env } from './env.js';

export function cloudinaryConfigured() {
  return Boolean(env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET);
}

export function signUploadParams(params) {
  // The API secret never leaves the server; only the signature is returned.
  return cloudinary.utils.api_sign_request(params, env.CLOUDINARY_API_SECRET);
}
