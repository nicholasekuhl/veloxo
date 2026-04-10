const express = require('express')
const router = express.Router()
const {
  getCampaigns,
  getCampaign,
  createCampaign,
  updateCampaign,
  deleteCampaign,
  enrollLeads,
  enrollBucket,
  startCampaign,
  pauseCampaign,
  duplicateCampaign
} = require('../controllers/campaignsController')

router.get('/', getCampaigns)
router.get('/:id', getCampaign)
router.post('/', createCampaign)
router.put('/:id', updateCampaign)
router.delete('/:id', deleteCampaign)
router.post('/:id/enroll', enrollLeads)
router.post('/:id/enroll-bucket/:bucketId', enrollBucket)
router.post('/:id/start', startCampaign)
router.post('/:id/pause', pauseCampaign)
router.post('/:id/duplicate', duplicateCampaign)

module.exports = router