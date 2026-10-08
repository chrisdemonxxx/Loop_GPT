'use client'

/**
 * Shim: the implementation lives in @loop/api-client now. This path stays so
 * every existing import keeps working; new code should import the package.
 */
import axios from 'axios'
if (axios?.defaults) axios.defaults.withCredentials = true
export * from '@loop/api-client'