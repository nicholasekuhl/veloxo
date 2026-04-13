const express = require('express')
const router = express.Router()
const { getBuckets, getArchivedBuckets, createBucket, updateBucket, patchBucket, deleteBucket, reorderBuckets } = require('../controllers/bucketsController')

router.get('/', getBuckets)
router.get('/archived', getArchivedBuckets)
router.post('/', createBucket)
router.patch('/reorder', reorderBuckets)
router.put('/:id', updateBucket)
router.patch('/:id', patchBucket)
router.delete('/:id', deleteBucket)

module.exports = router
