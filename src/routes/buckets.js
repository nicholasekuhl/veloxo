const express = require('express')
const router = express.Router()
const { getBuckets, createBucket, updateBucket, patchBucket, deleteBucket } = require('../controllers/bucketsController')

router.get('/', getBuckets)
router.post('/', createBucket)
router.put('/:id', updateBucket)
router.patch('/:id', patchBucket)
router.delete('/:id', deleteBucket)

module.exports = router
